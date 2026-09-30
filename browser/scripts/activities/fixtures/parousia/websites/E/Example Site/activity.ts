// A fixture: real Activities import their types from "parousia".
export default {
  detect(page: { url: URL; title: string }, settings: Readonly<Record<string, unknown>>) {
    return {
      id: "example-site",
      name: "Example Site",
      url: `${page.url.origin}${page.url.pathname}`,
      details: `${String(settings.prefix)} ${page.title}`,
    };
  },
};
