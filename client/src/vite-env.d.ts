/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEMINI_API_KEY?: string;
<<<<<<< HEAD
  /** Base URL of the agent-core webhook_server, e.g. http://localhost:8090 */
  readonly VITE_AGENT_API_URL?: string;
  /** Only needed if the agent was started with CLIENT_API_TOKEN set. */
  readonly VITE_AGENT_API_TOKEN?: string;
=======
>>>>>>> main
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
