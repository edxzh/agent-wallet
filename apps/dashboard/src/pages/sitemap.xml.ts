import type { APIRoute } from 'astro';

/** Each page in both languages, each pointing at its other-language version. */
const PAGES = ['', 'try/'];

export const GET: APIRoute = ({ site }) => {
  const abs = (p: string) => new URL(p, site).href;
  const url = (lang: 'en' | 'zh', page: string) => {
    const en = `/${page}`;
    const zh = `/zh/${page}`;
    return `  <url>
    <loc>${abs(lang === 'en' ? en : zh)}</loc>
    <xhtml:link rel="alternate" hreflang="zh-Hans" href="${abs(zh)}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${abs(en)}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${abs(en)}"/>
  </url>`;
  };
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${PAGES.flatMap((p) => [url('en', p), url('zh', p)]).join('\n')}
</urlset>
`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
