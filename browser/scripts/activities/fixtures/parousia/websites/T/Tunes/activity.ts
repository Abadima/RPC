// A fixture: real Activities import their types from "parousia".
export default {
  detect(page: {
    url: URL;
    title: string;
    granted: readonly string[];
    media?: { title?: string; artist?: string };
    thumbnail?: string;
  }) {
    return {
      id: "tunes",
      name: "Tunes",
      url: `${page.url.origin}${page.url.pathname}`,
      details: page.media?.title ?? page.title,
      ...(page.thumbnail && { assets: { largeImage: page.thumbnail } }),
    };
  },
};
