// The config the tests run against.
export const TEST_CONFIG = {
  name: "Widgetron",
  contact: "Still stuck? Email help@example.com.",
  sources: [
    { id: "gh", kind: "github", repo: "acme/widgetron", branch: "main", path: "docs", every: "1d" },
    { id: "site", kind: "sitemap", sitemap: "https://docs.example.com/sitemap.xml", hosts: ["docs.example.com"], every: "1d", paused: true },
  ],
  inbox: { enabled: true, dailyCap: 5, ownAddresses: ["support@example.com"] },
  limits: { perIpPerMinute: 10, perIpPerDay: 60, perSession: 20, dailyCap: 1000 },
};
