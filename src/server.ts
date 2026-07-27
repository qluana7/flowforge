const publicRoot = new URL("../public/", import.meta.url);

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".map")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

Deno.serve({ port: 8000 }, async (request) => {
  const url = new URL(request.url);
  const relativePath = url.pathname === "/"
    ? "index.html"
    : url.pathname.replace(/^\/+/, "");
  if (relativePath.includes("..")) {
    return new Response("Bad request", { status: 400 });
  }

  try {
    const file = await Deno.readFile(new URL(relativePath, publicRoot));
    return new Response(file, {
      headers: {
        "content-type": contentType(relativePath),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
});

console.log("Flowforge demo: http://localhost:8000");
