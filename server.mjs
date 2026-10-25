import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const port = Number(process.env.PORT || 4173);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json" };

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) file = pathname.startsWith("/map") ? join(root, "map", "index.html") : join(root, "index.html");
  response.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Permissions-Policy": "geolocation=(self)",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });
  createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0", () => console.log(`http://127.0.0.1:${port}/map/`));
