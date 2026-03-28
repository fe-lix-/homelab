import { create } from 'xmlbuilder2';

export interface RssItem {
  title: string;
  guid: string;
  link: string;
  comments: string;
  pubDate: string;
  category: string;
  description: string;
  enclosureUrl: string;
  enclosureLength: number;
  newznabCategory: number;
  season?: string;
}

/**
 * Build the Newznab caps XML response.
 */
export function buildCapsXml(): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' });
  const caps = root.ele('caps');

  caps.ele('server', {
    version: '1.0',
    title: 'JoynArr',
    strapline: 'Joyn.de bridge for *arr ecosystem',
    email: '',
    url: '',
    image: '',
  });

  caps.ele('limits', { max: '100', default: '50' });
  caps.ele('registration', { available: 'no', open: 'no' });

  const searching = caps.ele('searching');
  searching.ele('search', { available: 'yes', supportedParams: 'q' });
  searching.ele('tv-search', { available: 'yes', supportedParams: 'q,season,ep,tvdbid' });
  searching.ele('movie-search', { available: 'no', supportedParams: '' });
  searching.ele('audio-search', { available: 'no', supportedParams: '' });

  const categories = caps.ele('categories');
  const tvCat = categories.ele('category', { id: '5000', name: 'TV' });
  tvCat.ele('subcat', { id: '5030', name: 'SD' });
  tvCat.ele('subcat', { id: '5040', name: 'HD' });

  return root.end({ prettyPrint: true });
}

/**
 * Build an RSS/Newznab XML response for search results.
 */
export function buildRssXml(items: RssItem[], total: number, offset: number): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' });
  const rss = root.ele('rss', {
    version: '2.0',
    'xmlns:atom': 'http://www.w3.org/2005/Atom',
    'xmlns:newznab': 'http://www.newznab.com/DTD/2010/feeds/attributes/',
  });

  const ch = rss.ele('channel');
  ch.ele('title').txt('JoynArr');
  ch.ele('description').txt('Joyn.de Newznab Bridge');
  ch.ele('link').txt('https://github.com/JoynArr');
  ch.ele('language').txt('de-de');
  ch.ele('newznab:response', { offset: String(offset), total: String(total) });

  for (const item of items) {
    const it = ch.ele('item');
    it.ele('title').txt(item.title);
    it.ele('guid', { isPermaLink: 'true' }).txt(item.guid);
    it.ele('link').txt(item.link);
    it.ele('comments').txt(item.comments);
    it.ele('pubDate').txt(item.pubDate);
    it.ele('category').txt(item.category);
    it.ele('description').txt(item.description);
    it.ele('enclosure', {
      url: item.enclosureUrl,
      length: String(item.enclosureLength),
      type: 'application/x-nzb',
    });
    it.ele('newznab:attr', { name: 'category', value: String(item.newznabCategory) });
    it.ele('newznab:attr', { name: 'size', value: String(item.enclosureLength) });
    if (item.season !== undefined) {
      it.ele('newznab:attr', { name: 'season', value: item.season });
    }
  }

  return root.end({ prettyPrint: true });
}
