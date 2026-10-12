/// <reference types="vite/client" />

// The tracked client/.env sets the base URLs to relative /api/* paths, which the
// vite.config.ts dev proxy forwards to the services. A Docker image takes them
// from build args instead (client/.env is dockerignored; the defaults are
// absolute), so the /api/* routes in its nginx.conf are used only when it is
// built with relative ones. An absolute URL calls the service directly, across
// origins.
interface ImportMetaEnv {
  /** Base URL of the agent-core webhook_server, e.g. /api/agent or http://localhost:8090 */
  readonly VITE_AGENT_API_URL?: string;
  /** Only needed if the agent was started with CLIENT_API_TOKEN set. */
  readonly VITE_AGENT_API_TOKEN?: string;
  /** Base URL of the doc-converter service, e.g. /api/converter or http://localhost:5001 */
  readonly VITE_CONVERTER_URL?: string;
  /** Only needed if the converter was started with API_TOKEN set. */
  readonly VITE_CONVERTER_TOKEN?: string;
  /** Base URL of the RAG knowledge base (server/), e.g. /api/rag or http://localhost:8100 */
  readonly VITE_RAG_API_URL?: string;
  /** Only needed if the RAG server was started with IDAR_API_TOKEN set. */
  readonly VITE_RAG_API_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
