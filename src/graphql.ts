// GraphQL v4 surface: POST /api/graphql.
// Minimal hand-rolled GraphQL parser + executor for exactly the operations the
// make.fun suite sends (contract/04-graphql-mcp-bench.md section 1). Stdlib only,
// no GraphQL library. Reads/writes the SAME store as REST (src/store.ts).
// Determinism: all timestamps from nowIso(); no Date.now()/Math.random().

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER,
  globalId,
  parseGlobalId,
  nowIso,
  commitEpoch,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
  type User,
} from './store.ts';
import { authViewer, jsonError, parseJsonBody, readBody, sendJson } from './http.ts';
import {
  ZERO_OID,
  buildCommit,
  isValidOid,
  objectId,
  parseCommit,
  parseTree,
} from './gitobj.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, value: string, l: number, c: number): void => {
    tokens.push({ kind, value, line: l, column: c });
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
        column += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      push('Punct', '...', startLine, startCol);
      i += 3;
      column += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      push('Punct', ch, startLine, startCol);
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or normal "..." with escapes.
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        const consumed = end === -1 ? src.length - i : end + 3 - i;
        for (const c of raw) {
          if (c === '\n') {
            line += 1;
            column = 1;
          } else {
            column += 1;
          }
        }
        column += 3;
        push('String', raw.replace(/^\n/, '').replace(/\n$/, ''), startLine, startCol);
        i += consumed;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
          column += 2;
          continue;
        }
        if (c === '\n') {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new Error(`unterminated string at line ${startLine}`);
      push('String', out, startLine, startCol);
      i = j + 1;
      column += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      const raw = src.slice(i, j);
      column += j - i;
      push(isFloat ? 'Float' : 'Int', raw, startLine, startCol);
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      column += j - i;
      push('Name', raw, startLine, startCol);
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at line ${startLine}`);
  }
  tokens.push({ kind: 'EOF', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | {
      kind: 'Field';
      alias: string | null;
      name: string;
      args: Record<string, ValueNode>;
      selections: SelectionNode[] | null;
    }
  | { kind: 'InlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string };

interface VarDef {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): Token {
    const tok = this.next();
    if (tok.kind !== 'Punct' || tok.value !== value) {
      throw new Error(`expected "${value}" but got ${tok.value} at line ${tok.line}`);
    }
    return tok;
  }

  private expectName(value?: string): Token {
    const tok = this.next();
    if (tok.kind !== 'Name' || (value !== undefined && tok.value !== value)) {
      throw new Error(`expected name ${value ?? ''} but got ${tok.value} at line ${tok.line}`);
    }
    return tok;
  }

  private isPunct(value: string): boolean {
    const tok = this.peek();
    return tok.kind === 'Punct' && tok.value === value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'EOF') {
      const tok = this.peek();
      if (tok.kind === 'Name' && tok.value === 'fragment') {
        const frag = this.parseFragment();
        doc.fragments.set(frag.name, frag);
      } else {
        doc.operations.push(this.parseOperation());
      }
    }
    return doc;
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName().value;
    this.expectName('on');
    const typeCondition = this.expectName().value;
    const selections = this.parseSelectionSet();
    return { name, typeCondition, selections };
  }

  private parseOperation(): OperationNode {
    const tok = this.peek();
    let kind: 'query' | 'mutation' | 'subscription' = 'query';
    if (tok.kind === 'Name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      kind = tok.value as 'query' | 'mutation' | 'subscription';
      this.next();
    }
    let name: string | null = null;
    if (this.peek().kind === 'Name') name = this.next().value;
    const varDefs = this.isPunct('(') ? this.parseVarDefs() : [];
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName().value;
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): string {
    let out = '';
    if (this.isPunct('[')) {
      this.next();
      out = `[${this.parseType()}]`;
    } else {
      out = this.expectName().value;
    }
    if (this.isPunct('!')) {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.expectPunct('{');
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'EOF') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      return { kind: 'InlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName().value;
    }
    const args = this.isPunct('(') ? this.parseArgs() : {};
    const selections = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, args, selections };
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const name = this.expectName().value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'Punct' && tok.value === '$') {
      return { kind: 'Variable', name: this.expectName().value };
    }
    if (tok.kind === 'Int') return { kind: 'Int', value: parseInt(tok.value, 10) };
    if (tok.kind === 'Float') return { kind: 'Float', value: parseFloat(tok.value) };
    if (tok.kind === 'String') return { kind: 'String', value: tok.value };
    if (tok.kind === 'Name') {
      if (tok.value === 'true') return { kind: 'Boolean', value: true };
      if (tok.value === 'false') return { kind: 'Boolean', value: false };
      if (tok.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: tok.value };
    }
    if (tok.kind === 'Punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (tok.kind === 'Punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    throw new Error(`unexpected value token ${tok.value} at line ${tok.line}`);
  }
}

// ---------------------------------------------------------------------------
// Value resolution (variables -> JS values)
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
    case 'Float':
    case 'String':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => resolveValue(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args)) out[key] = resolveValue(args[key] as ValueNode, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema surface (field sets for validation + introspection)
// ---------------------------------------------------------------------------

const FIELD_SETS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['id', 'login', 'name', 'email']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'url', 'createdAt', 'isPrivate',
  ]),
  Ref: new Set(['id', 'name', 'prefix', 'target']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  PullRequest: new Set([
    'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName',
    'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url',
  ]),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileEdge: new Set(['node', 'cursor']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changes', 'status']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'comment', 'clientMutationId']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt', 'updatedAt', 'url']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields', 'interfaces', 'possibleTypes']),
  __Field: new Set(['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason']),
  __EnumValue: new Set(['name', 'description', 'isDeprecated', 'deprecationReason']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
  __Schema: new Set(['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives']),
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName',
    'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'url', 'createdAt', 'isPrivate',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

/** Opaque wrapper marking a resolved object value and its GraphQL type. */
interface Wrapper {
  $type: string;
  $value: unknown;
}

function wrap(type: string, value: unknown): Wrapper {
  return { $type: type, $value: value };
}

function isWrapper(v: unknown): v is Wrapper {
  return typeof v === 'object' && v !== null && '$type' in v && '$value' in v;
}

function repoGid(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGid(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function commentGid(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function findRepoById(id: number): Repo | undefined {
  return store.getRepoById(id);
}

/** Parse an Issue/PullRequest global id of the form "<repoId>:<number>". */
function parseRepoItemId(gid: string): { repo: Repo; number: number } | null {
  const parsed = parseGlobalId(gid);
  if (parsed === null) return null;
  const parts = parsed.id.split(':');
  if (parts.length !== 2) return null;
  const repo = findRepoById(Number(parts[0]));
  if (repo === undefined) return null;
  const number = Number(parts[1]);
  if (!Number.isInteger(number)) return null;
  return { repo, number };
}

function encodeCursor(n: number): string {
  return Buffer.from(`issue:${n}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^issue:(\d+)$/.exec(text);
    if (m === null) return null;
    return Number(m[1]);
  } catch {
    return null;
  }
}

// --- issue / PR creation, mirroring the REST shapes in src/store.ts ---

function createIssueInStore(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [],
    seq: repo.nextIssue,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return issue;
}

function createPullInStore(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
  const headSha = repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID;
  const pull: Pull = {
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    headRef,
    baseRef,
    headSha,
    baseSha,
    seq: repo.nextPull,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Build a real merge commit (tree = head tree, parents = base + head) and move the base ref. */
function buildMergeCommit(repo: Repo, pull: Pull): string {
  const headObj = repo.objects.get(pull.headSha);
  const baseObj = repo.objects.get(pull.baseSha);
  if (
    headObj === undefined || baseObj === undefined ||
    headObj.type !== 'commit' || baseObj.type !== 'commit' ||
    !isValidOid(pull.headSha) || !isValidOid(pull.baseSha) ||
    pull.headSha === ZERO_OID || pull.baseSha === ZERO_OID
  ) {
    return isValidOid(pull.headSha) && pull.headSha !== ZERO_OID ? pull.headSha : ZERO_OID;
  }
  const headTree = parseCommit(headObj.data).tree;
  const epoch = commitEpoch(repo.nextCommitSeq);
  repo.nextCommitSeq += 1;
  const ident = `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  const data = buildCommit({
    tree: headTree,
    parents: [pull.baseSha, pull.headSha],
    author: ident,
    committer: ident,
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n`,
  });
  const oid = objectId('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  return oid;
}

// --- PR files: diff base tree vs head tree ---

function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.oid, path, out);
    } else if (entry.mode !== '160000') {
      out.set(path, entry.oid);
    }
  }
}

function pullRequestFiles(repo: Repo, pull: Pull): string[] {
  const baseObj = repo.objects.get(pull.baseSha);
  const headObj = repo.objects.get(pull.headSha);
  if (baseObj === undefined || headObj === undefined) return [];
  if (baseObj.type !== 'commit' || headObj.type !== 'commit') return [];
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  flattenTree(repo, parseCommit(baseObj.data).tree, '', baseFiles);
  flattenTree(repo, parseCommit(headObj.data).tree, '', headFiles);
  const paths: string[] = [];
  for (const [path, oid] of headFiles) {
    if (baseFiles.get(path) !== oid) paths.push(path);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) paths.push(path);
  }
  return paths.sort();
}

// --- issues connection ---

interface IssuesConnectionValue {
  repo: Repo;
  nodes: Issue[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): IssuesConnectionValue {
  let list = [...repo.issues];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? undefined;
  const direction = orderBy !== undefined && typeof orderBy['direction'] === 'string' ? orderBy['direction'] : 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = args['after'];
  if (typeof after === 'string' && after !== '') {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = list.findIndex((i) => i.number === n);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = typeof args['first'] === 'number' ? args['first'] : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  return {
    repo,
    nodes: page,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor((page[0] as Issue).number) : null,
      endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface ExecContext {
  viewer: User;
  errors: GqlError[];
  variables: Variables;
  doc: DocumentNode;
}

function resolveSelections(
  typeName: string,
  source: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'InlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, resolveSelections(typeName, source, sel.selections, ctx, path));
      }
      continue;
    }
    if (sel.kind === 'FragmentSpread') {
      const frag = ctx.doc.fragments.get(sel.name);
      if (frag !== undefined && frag.typeCondition === typeName) {
        Object.assign(out, resolveSelections(typeName, source, frag.selections, ctx, path));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    const raw = resolveField(typeName, source, sel, ctx, fieldPath);
    out[key] = applySubSelections(raw, sel, ctx, fieldPath);
  }
  return out;
}

function applySubSelections(
  raw: unknown,
  field: Extract<SelectionNode, { kind: 'Field' }>,
  ctx: ExecContext,
  path: Array<string | number>,
): unknown {
  if (field.selections === null || raw === null || raw === undefined) return raw;
  if (isWrapper(raw)) {
    return resolveSelections(raw.$type, raw.$value, field.selections, ctx, path);
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (isWrapper(item)) return resolveSelections(item.$type, item.$value, field.selections, ctx, path);
      return item;
    });
  }
  return raw;
}

function resolveField(
  typeName: string,
  source: unknown,
  field: Extract<SelectionNode, { kind: 'Field' }>,
  ctx: ExecContext,
  path: Array<string | number>,
): unknown {
  const allowed = FIELD_SETS[typeName];
  if (allowed === undefined || !allowed.has(field.name)) {
    ctx.errors.push({
      message: `Cannot query field "${field.name}" on type "${typeName}".`,
      path,
    });
    return null;
  }
  const args = resolveArgs(field.args, ctx.variables);
  switch (typeName) {
    case 'Query':
      return resolveQueryField(field.name, args);
    case 'Mutation':
      return resolveMutationField(field.name, args);
    case 'User':
      return resolveUserField(source as User, field.name);
    case 'Repository':
      return resolveRepositoryField(source as Repo, field.name, args);
    case 'Ref':
      return resolveRefField(source as { name: string }, field.name);
    case 'Issue':
      return resolveIssueField(source as Issue, field.name, args);
    case 'IssueConnection':
      return resolveIssueConnectionField(source as IssuesConnectionValue, field.name);
    case 'IssueEdge':
      return (source as { node: unknown; cursor: string })[field.name as 'node' | 'cursor'];
    case 'PageInfo':
      return (source as IssuesConnectionValue['pageInfo'])[field.name as keyof IssuesConnectionValue['pageInfo']];
    case 'PullRequest':
      return resolvePullRequestField(source as { repo: Repo; pull: Pull }, field.name, args);
    case 'PullRequestConnection':
      return resolvePullConnectionField(source as { repo: Repo; pulls: Pull[] }, field.name);
    case 'PullRequestEdge':
      return (source as { node: unknown; cursor: string })[field.name as 'node' | 'cursor'];
    case 'PullRequestChangedFileConnection':
      return resolveChangedFileConnectionField(source as string[], field.name);
    case 'PullRequestChangedFileEdge':
      return (source as { node: unknown; cursor: string })[field.name as 'node' | 'cursor'];
    case 'PullRequestChangedFile':
      return resolveChangedFileField(source as { path: string }, field.name);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return (source as { issue: Wrapper })[field.name as 'issue'];
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return (source as { pullRequest: Wrapper })[field.name as 'pullRequest'];
    case 'AddCommentPayload':
      return (source as { commentEdge: Wrapper })[field.name as 'commentEdge'];
    case 'IssueCommentEdge':
      return (source as { node: Wrapper })[field.name as 'node'];
    case 'IssueComment':
      return resolveCommentField(source as { id: string; body: string }, field.name);
    case '__Type':
      return resolveTypeField(source as { name: string; kind: string; fields: string[] | null; enumValues: string[] | null }, field.name, args);
    case '__Field':
      return resolveMetaField(source as { name: string }, field.name);
    case '__EnumValue':
      return resolveMetaField(source as { name: string }, field.name);
    case '__InputValue':
      return resolveMetaField(source as { name: string }, field.name);
    case '__Schema':
      return null;
    default:
      return null;
  }
}

function resolveQueryField(name: string, args: Record<string, unknown>): unknown {
  if (name === 'viewer') return wrap('User', VIEWER);
  if (name === 'repository') {
    const owner = args['owner'];
    const repoName = args['name'];
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = store.getRepo(owner, repoName);
    return repo === undefined ? null : wrap('Repository', repo);
  }
  if (name === 'node') {
    const id = args['id'];
    if (typeof id !== 'string') return null;
    return resolveNode(id);
  }
  if (name === '__type') {
    const typeName = args['name'];
    if (typeof typeName !== 'string') return null;
    return resolveIntrospectionType(typeName);
  }
  if (name === '__schema') return wrap('__Schema', {});
  return null;
}

function resolveIntrospectionType(name: string): Wrapper | null {
  if (INTROSPECTION_FIELDS[name] !== undefined) {
    return wrap('__Type', { name, kind: 'OBJECT', fields: INTROSPECTION_FIELDS[name], enumValues: null });
  }
  if (INTROSPECTION_ENUMS[name] !== undefined) {
    return wrap('__Type', { name, kind: 'ENUM', fields: null, enumValues: INTROSPECTION_ENUMS[name] });
  }
  return null;
}

function resolveNode(id: string): Wrapper | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoById(Number(parsed.id));
    return repo === undefined ? null : wrap('Repository', repo);
  }
  if (parsed.kind === 'User') {
    return Number(parsed.id) === VIEWER.id ? wrap('User', VIEWER) : null;
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const found = parseRepoItemId(id);
    if (found === null) return null;
    if (parsed.kind === 'Issue') {
      const issue = found.repo.issues.find((i) => i.number === found.number);
      return issue === undefined ? null : wrap('Issue', { repo: found.repo, issue });
    }
    const pull = found.repo.pulls.find((p) => p.number === found.number);
    return pull === undefined ? null : wrap('PullRequest', { repo: found.repo, pull });
  }
  if (parsed.kind === 'IssueComment') {
    const parts = parsed.id.split(':');
    if (parts.length !== 3) return null;
    const repo = findRepoById(Number(parts[0]));
    if (repo === undefined) return null;
    const issue = repo.issues.find((i) => i.number === Number(parts[1]));
    if (issue === undefined) return null;
    const comment = issue.comments.find((c) => c.id === Number(parts[2]));
    if (comment === undefined) return null;
    return wrap('IssueComment', { id, body: comment.body });
  }
  return null;
}

function resolveMutationField(name: string, args: Record<string, unknown>): unknown {
  const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
  if (name === 'createIssue') {
    const repoId = input['repositoryId'];
    if (typeof repoId !== 'string') return wrap('CreateIssuePayload', { issue: null });
    const parsed = parseGlobalId(repoId);
    const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(Number(parsed.id)) : undefined;
    if (repo === undefined) return wrap('CreateIssuePayload', { issue: null });
    const issue = createIssueInStore(
      repo,
      typeof input['title'] === 'string' ? input['title'] : '',
      typeof input['body'] === 'string' ? input['body'] : '',
    );
    return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo, issue }) });
  }
  if (name === 'closeIssue') {
    const issueId = input['issueId'];
    if (typeof issueId !== 'string') return wrap('CloseIssuePayload', { issue: null });
    const found = parseRepoItemId(issueId);
    if (found === null) return wrap('CloseIssuePayload', { issue: null });
    const issue = found.repo.issues.find((i) => i.number === found.number);
    if (issue === undefined) return wrap('CloseIssuePayload', { issue: null });
    issue.state = 'closed';
    return wrap('CloseIssuePayload', { issue: wrap('Issue', { repo: found.repo, issue }) });
  }
  if (name === 'createPullRequest') {
    const repoId = input['repositoryId'];
    if (typeof repoId !== 'string') return wrap('CreatePullRequestPayload', { pullRequest: null });
    const parsed = parseGlobalId(repoId);
    const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(Number(parsed.id)) : undefined;
    if (repo === undefined) return wrap('CreatePullRequestPayload', { pullRequest: null });
    const pull = createPullInStore(
      repo,
      typeof input['title'] === 'string' ? input['title'] : '',
      typeof input['body'] === 'string' ? input['body'] : '',
      typeof input['headRefName'] === 'string' ? input['headRefName'] : '',
      typeof input['baseRefName'] === 'string' ? input['baseRefName'] : '',
    );
    return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pull }) });
  }
  if (name === 'mergePullRequest') {
    const prId = input['pullRequestId'];
    if (typeof prId !== 'string') return wrap('MergePullRequestPayload', { pullRequest: null });
    const found = parseRepoItemId(prId);
    if (found === null) return wrap('MergePullRequestPayload', { pullRequest: null });
    const pull = found.repo.pulls.find((p) => p.number === found.number);
    if (pull === undefined) return wrap('MergePullRequestPayload', { pullRequest: null });
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = buildMergeCommit(found.repo, pull);
    return wrap('MergePullRequestPayload', { pullRequest: wrap('PullRequest', { repo: found.repo, pull }) });
  }
  if (name === 'addComment') {
    const subjectId = input['subjectId'];
    const body = typeof input['body'] === 'string' ? input['body'] : '';
    if (typeof subjectId !== 'string') return wrap('AddCommentPayload', { commentEdge: null });
    const parsed = parseGlobalId(subjectId);
    if (parsed !== null && parsed.kind === 'Issue') {
      const found = parseRepoItemId(subjectId);
      if (found !== null) {
        const issue = found.repo.issues.find((i) => i.number === found.number);
        if (issue !== undefined) {
          const comment: IssueComment = { id: found.repo.nextComment, body, seq: found.repo.nextComment };
          found.repo.nextComment += 1;
          issue.comments.push(comment);
          const node = wrap('IssueComment', { id: commentGid(found.repo, issue, comment), body });
          return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node }) });
        }
      }
    }
    // Non-issue subject (e.g. a PR): echo a comment-shaped node; not REST-visible.
    const node = wrap('IssueComment', { id: globalId('IssueComment', `0:0:${subjectId}`), body });
    return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node }) });
  }
  return null;
}

function resolveUserField(user: User, name: string): unknown {
  if (name === 'id') return globalId('User', String(user.id));
  if (name === 'login') return user.login;
  if (name === 'name') return user.name;
  if (name === 'email') return user.email;
  return null;
}

function resolveRepositoryField(repo: Repo, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'id':
      return repoGid(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return wrap('User', { id: 0, login: repo.owner, name: repo.owner, email: '' });
    case 'defaultBranchRef':
      return wrap('Ref', { name: repo.defaultBranch });
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'url':
      return `/api/v3/repos/${repo.owner}/${repo.name}`;
    case 'createdAt':
      return nowIso();
    case 'isPrivate':
      return repo.private;
    case 'issue': {
      const n = args['number'];
      if (typeof n !== 'number') return null;
      const issue = repo.issues.find((i) => i.number === n);
      return issue === undefined ? null : wrap('Issue', { repo, issue });
    }
    case 'issues':
      return wrap('IssueConnection', issuesConnection(repo, args));
    case 'pullRequests': {
      let pulls = [...repo.pulls];
      const first = typeof args['first'] === 'number' ? args['first'] : pulls.length;
      pulls = pulls.slice(0, Math.max(0, first));
      return wrap('PullRequestConnection', { repo, pulls });
    }
    case 'pullRequest': {
      const n = args['number'];
      if (typeof n !== 'number') return null;
      const pull = repo.pulls.find((p) => p.number === n);
      return pull === undefined ? null : wrap('PullRequest', { repo, pull });
    }
    default:
      return null;
  }
}

function resolveRefField(ref: { name: string }, name: string): unknown {
  if (name === 'id') return globalId('Ref', ref.name);
  if (name === 'name') return ref.name;
  if (name === 'prefix') return 'refs/heads/';
  if (name === 'target') return null;
  return null;
}

function resolveIssueField(source: { repo: Repo; issue: Issue }, name: string, _args: Record<string, unknown>): unknown {
  const { repo, issue } = source;
  switch (name) {
    case 'id':
      return issueGid(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issueState(issue);
    case 'body':
      return issue.body;
    case 'author':
      return wrap('User', VIEWER);
    case 'createdAt':
    case 'updatedAt':
      return nowIso();
    case 'url':
      return `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'comments':
      return issue.comments.map((c) => wrap('IssueComment', { id: commentGid(repo, issue, c), body: c.body }));
    case 'labels':
      return issue.labels.map((l) => l);
    default:
      return null;
  }
}

function resolveIssueConnectionField(source: IssuesConnectionValue, name: string): unknown {
  if (name === 'nodes') {
    return source.nodes.map((issue) => wrap('Issue', { repo: source.repo, issue }));
  }
  if (name === 'edges') {
    return source.nodes.map((issue) =>
      wrap('IssueEdge', { node: wrap('Issue', { repo: source.repo, issue }), cursor: encodeCursor(issue.number) }),
    );
  }
  if (name === 'pageInfo') return wrap('PageInfo', source.pageInfo);
  if (name === 'totalCount') return source.nodes.length;
  return null;
}

function resolvePullConnectionField(source: { repo: Repo; pulls: Pull[] }, name: string): unknown {
  if (name === 'nodes') return source.pulls.map((pull) => wrap('PullRequest', { repo: source.repo, pull }));
  if (name === 'edges') {
    return source.pulls.map((pull) =>
      wrap('PullRequestEdge', { node: wrap('PullRequest', { repo: source.repo, pull }), cursor: '' }),
    );
  }
  if (name === 'pageInfo') {
    return wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
  }
  if (name === 'totalCount') return source.pulls.length;
  return null;
}

function resolveChangedFileConnectionField(paths: string[], name: string): unknown {
  if (name === 'nodes') return paths.map((p) => wrap('PullRequestChangedFile', { path: p }));
  if (name === 'edges') return paths.map((p) => wrap('PullRequestChangedFileEdge', { node: wrap('PullRequestChangedFile', { path: p }), cursor: '' }));
  if (name === 'pageInfo') {
    return wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
  }
  if (name === 'totalCount') return paths.length;
  return null;
}

function resolveChangedFileField(source: { path: string }, name: string): unknown {
  if (name === 'path') return source.path;
  if (name === 'additions') return 1;
  if (name === 'deletions') return 0;
  if (name === 'changes') return 1;
  if (name === 'status') return 'added';
  return null;
}

function resolvePullRequestField(source: { repo: Repo; pull: Pull }, name: string, args: Record<string, unknown>): unknown {
  const { repo, pull } = source;
  switch (name) {
    case 'id':
      return pullGid(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'state':
      return pullState(pull);
    case 'body':
      return pull.body;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable':
      return 'MERGEABLE';
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt === '' ? null : pull.mergedAt;
    case 'author':
      return wrap('User', VIEWER);
    case 'createdAt':
    case 'updatedAt':
      return nowIso();
    case 'url':
      return `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
    case 'files': {
      const paths = pullRequestFiles(repo, pull);
      const first = typeof args['first'] === 'number' ? args['first'] : paths.length;
      return wrap('PullRequestChangedFileConnection', paths.slice(0, Math.max(0, first)));
    }
    default:
      return null;
  }
}

function resolveCommentField(source: { id: string; body: string }, name: string): unknown {
  if (name === 'id') return source.id;
  if (name === 'body') return source.body;
  if (name === 'author') return wrap('User', VIEWER);
  if (name === 'createdAt' || name === 'updatedAt') return nowIso();
  if (name === 'url') return null;
  return null;
}

function resolveTypeField(
  source: { name: string; kind: string; fields: string[] | null; enumValues: string[] | null },
  name: string,
  args: Record<string, unknown>,
): unknown {
  if (name === 'name') return source.name;
  if (name === 'kind') return source.kind;
  if (name === 'description') return null;
  if (name === 'fields') {
    if (source.fields === null) return null;
    return source.fields.map((f) => wrap('__Field', { name: f }));
  }
  if (name === 'enumValues') {
    if (source.enumValues === null) return null;
    return source.enumValues.map((v) => wrap('__EnumValue', { name: v }));
  }
  if (name === 'ofType' || name === 'inputFields' || name === 'interfaces' || name === 'possibleTypes') return null;
  void args;
  return null;
}

function resolveMetaField(source: { name: string }, name: string): unknown {
  if (name === 'name') return source.name;
  if (name === 'description') return null;
  if (name === 'isDeprecated') return false;
  if (name === 'deprecationReason') return null;
  if (name === 'args' || name === 'type' || name === 'defaultValue') return null;
  return null;
}

// ---------------------------------------------------------------------------
// Document execution
// ---------------------------------------------------------------------------

interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: GqlError[];
}

function executeOperation(
  doc: DocumentNode,
  operationName: string | undefined,
  variables: Variables,
): GqlResult {
  const errors: GqlError[] = [];
  let op: OperationNode | undefined;
  if (operationName !== undefined) {
    op = doc.operations.find((o) => o.name === operationName);
    if (op === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    op = doc.operations[0] as OperationNode;
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operations in document.' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const resolvedVars: Variables = {};
  for (const def of op.varDefs) {
    if (variables[def.name] !== undefined) {
      resolvedVars[def.name] = variables[def.name];
    } else if (def.defaultValue !== null) {
      resolvedVars[def.name] = resolveValue(def.defaultValue, variables);
    } else if (def.type.endsWith('!')) {
      errors.push({ message: `Variable $${def.name} of required type ${def.type} was not provided.` });
    }
  }
  const ctx: ExecContext = { viewer: VIEWER, errors, variables: resolvedVars, doc };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(rootType, null, op.selections, ctx, []);
  const result: GqlResult = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function executeDocument(query: string, variables: Variables, operationName: string | undefined): GqlResult {
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  return executeOperation(doc, operationName, variables);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  if (url.startsWith('/')) {
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    return path === '' ? '/' : path;
  }
  try {
    return new URL(url, 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    jsonError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (authViewer(req) === null) {
    jsonError(res, 401, 'Unauthorized');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    jsonError(res, 400, 'Malformed JSON body');
    return true;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const e = (entry as Record<string, unknown> | null) ?? {};
      const query = typeof e['query'] === 'string' ? e['query'] : '';
      const variables = (e['variables'] as Variables | undefined) ?? {};
      const operationName = typeof e['operationName'] === 'string' ? e['operationName'] : undefined;
      return executeDocument(query, variables, operationName);
    });
    sendJson(res, 200, results);
    return true;
  }
  const obj = (body as Record<string, unknown> | null) ?? {};
  const query = typeof obj['query'] === 'string' ? obj['query'] : '';
  const variables = (obj['variables'] as Variables | undefined) ?? {};
  const operationName = typeof obj['operationName'] === 'string' ? obj['operationName'] : undefined;
  sendJson(res, 200, executeDocument(query, variables, operationName));
  return true;
}
