/** Testable pieces of the ask command. index.ts wires them to the real world. */

export const ASK_USAGE =
  'Usage: npm run ask -- [--repo <folder | owner/repo[@branch] | github.com URL>] "How does authentication work in this repo?"';

export interface AskArgs {
  question: string;
  /** A codebase to open instead of REPO_PATH, as typed. */
  repo?: string;
}

export class AskUsageError extends Error {}

/**
 * Split the command line into the question and an optional `--repo <location>`. `--repo`
 * may appear anywhere; every other word is part of the question.
 */
export function parseAskArgs(argv: string[]): AskArgs {
  const words: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") {
      const value = argv[++i];
      // A missing value, or another flag in its place, is a mistake worth saying so about.
      if (!value?.trim() || value.startsWith("--")) throw new AskUsageError("--repo needs a folder or a GitHub repository.");
      if (repo !== undefined) throw new AskUsageError("Give --repo only once.");
      repo = value.trim();
    } else {
      words.push(argv[i]);
    }
  }
  const question = words.join(" ").trim();
  if (!question) throw new AskUsageError("Ask a question.");
  return { question, repo };
}
