/** A short, human-readable description of a tool call for the trace. */
export function summarizeTool(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (tool) {
    case 'search_code':
    case 'search_docs':
      return `“${str(i['query'])}”${i['path_glob'] ? ` in ${str(i['path_glob'])}` : ''}`;
    case 'read_file': {
      const start = i['start'];
      const end = i['end'];
      const range = start || end ? `:${start ?? 1}–${end ?? ''}` : '';
      return `${str(i['path'])}${range}`;
    }
    case 'get_pr':
      return str(i['pr']);
    case 'get_pr_diff': {
      const parts = [str(i['pr'])];
      if (i['path']) parts.push(str(i['path']));
      if (i['page']) parts.push(`page ${i['page']}`);
      return parts.join(', ');
    }
    default:
      return JSON.stringify(input ?? {});
  }
}

/** Plain-language names for the tools, shown in the trace. */
export const TOOL_LABELS: Record<string, string> = {
  search_code: 'Search code',
  read_file: 'Read file',
  search_docs: 'Search docs',
  get_pr: 'Read PR',
  get_pr_diff: 'Read diff',
};
