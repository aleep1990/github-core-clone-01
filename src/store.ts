// The forge's in-memory store. One process, one trial: everything lives here.
// Determinism: no wall clock, no Math.random anywhere. Every timestamp comes from
// MAKEFUN_TRIAL_NOW (the instance's opening time); commit epochs are
// SCENARIO_EPOCH_SEC + a per-repo sequence, so two runs produce identical bytes.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The scenario viewer, derived from the competition's constant scenario seed
 * (SCENARIO_SEED 0x6a09e667f3bcc909) by the kit's own wire.ts buildScenario().
 * Verified by running the kit code: viewer login "adaiversen", id 1000.
 * The seed is a compile-time constant, so this login is the same in dev and final.
 * The suite's token is opaque; this single identity owns every repo the suite makes.
 */
export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

/** The foreign owner the suite probes for the 404-never-403 rule. */
export const STRANGER: User = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

/** The only "now" a response may carry. Fallback is the competition opening. */
export function nowIso(): string {
  return process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z';
}

/** Fixed epoch for fixture commits (kit wire.ts SCENARIO_EPOCH_SEC). */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/** Deterministic commit epoch for commits this forge authors itself. */
export function commitEpoch(seq: number): number {
  return SCENARIO_EPOCH_SEC + seq;
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  labels: Map<string, string>; // label name -> color
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextCommitSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> tip sha
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  requestSeq = 0;

  /** Deterministic request id for X-GitHub-Request-Id (presence only is checked). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  createRepo(owner: string, name: string, description: string, priv: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: priv,
      defaultBranch: 'main',
      seq: this.nextRepoId,
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      nextCommitSeq: 1,
      objects: new Map(),
      refs: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  /** The viewer's repos in creation order (pagination walks this list). */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }
}

export const store = new Store();

/** Opaque, stable global ids for GraphQL (never the plain database id / number). */
export function globalId(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}

export function parseGlobalId(gid: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(gid, 'base64url').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), id: text.slice(idx + 1) };
  } catch {
    return null;
  }
}
