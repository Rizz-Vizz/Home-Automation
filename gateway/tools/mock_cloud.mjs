// Local stand-in for a cloud ingest endpoint. Run: node tools/mock_cloud.mjs  then set
// CLOUD_SYNC_URL=http://127.0.0.1:9090/ingest and CLOUD_SYNC_TOKEN=demo in gateway/.env
import http from "node:http";
const TOKEN = process.env.CLOUD_SYNC_TOKEN || "demo";
let received = 0;
http
  .createServer((req, res) => {
    if (req.method === "GET") {
      res.end(JSON.stringify({ received }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      const items = JSON.parse(raw).items || [];
      received += items.length;
      console.log(`[mock cloud] +${items.length} items (total ${received}) latest:`, JSON.stringify(items.at(-1)?.payload));
      res.writeHead(200).end("{}");
    });
  })
  .listen(9090, "127.0.0.1", () => console.log("mock cloud on http://127.0.0.1:9090/ingest"));
