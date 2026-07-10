import { send, sendError, startHttpMock } from "./http-mock.mjs";

export const RSS_SCENARIOS = ["success", "empty", "malformed", "500", "timeout"];

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>dociai mock</title><item><title>モックニュース1</title><description>説明1</description><guid>rss-1</guid><pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate></item><item><title>モックニュース2</title><description>説明2</description><guid>rss-2</guid><pubDate>Fri, 10 Jul 2026 00:01:00 GMT</pubDate></item></channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>dociai mock</title><entry><id>atom-1</id><title>モックAtom</title><summary>Atom説明</summary><updated>2026-07-10T00:00:00Z</updated></entry></feed>`;

export function startRssServer(options = {}) {
  return startHttpMock({
    name: "rss",
    scenarios: RSS_SCENARIOS,
    initialScenario: options.scenario ?? "success",
    host: options.host,
    port: options.port,
    async handler({ res, url, scenario, hang }) {
      if (scenario === "timeout") return await hang();
      if (scenario === "500") return sendError(res, 500, "mock feed failure");
      if (scenario === "malformed") return send(res, 200, "<rss><broken>", "application/xml");
      if (scenario === "empty") return send(res, 200, "<?xml version=\"1.0\"?><rss><channel></channel></rss>", "application/xml");
      if (url.pathname === "/atom.xml") return send(res, 200, ATOM, "application/atom+xml; charset=utf-8");
      if (url.pathname === "/rss.xml") return send(res, 200, RSS, "application/rss+xml; charset=utf-8");
      return sendError(res, 404, "not found");
    },
  });
}
