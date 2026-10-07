import serverless from "serverless-http";
import { server } from "../../server.js";

export const handler = serverless(server, {
  basePath: "/.netlify/functions/server"
});
