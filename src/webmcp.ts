// Optional browser agent access to the same read-only status shown in the UI.
export function registerMonitoringTool() {
  const context = (document as Document & {modelContext?: {registerTool: (tool: unknown, options: {signal: AbortSignal}) => void | Promise<void>}}).modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    Promise.resolve(context.registerTool({
      name: 'read_server_status',
      description: 'Read current local host health, resource usage, and service inventory. Does not change the server.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      annotations: {readOnlyHint: true, untrustedContentHint: true},
      async execute(input: unknown) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object');
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('Local monitoring agent unavailable');
        const data = await response.json() as Record<string, unknown>;
        const status = {...data};
        delete status.token;
        return status;
      },
    }, {signal: lifecycle.signal})).catch(() => {});
  } catch { /* Monitoring works normally in unsupported browsers. */ }
  return () => lifecycle.abort();
}
