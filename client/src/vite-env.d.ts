/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the agent-core webhook_server, e.g. http://localhost:8090 */
  readonly VITE_AGENT_API_URL?: string;
  /** Only needed if the agent was started with CLIENT_API_TOKEN set. */
  readonly VITE_AGENT_API_TOKEN?: string;
  /** Base URL of the doc-converter service, e.g. http://localhost:5001 */
  readonly VITE_CONVERTER_URL?: string;
  /** Only needed if the converter was started with API_TOKEN set. */
  readonly VITE_CONVERTER_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
