import { create } from 'xmlbuilder2';

/**
 * Build a fake NZB XML document that embeds the video URL and title as XML comments.
 * The NZB is parseable by SABnzbd but contains no real Usenet segments — the downloader
 * side of JoynArr reads the embedded URL instead.
 */
export function buildFakeNzb(title: string, videoUrl: string): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('nzb', {
      xmlns: 'http://www.newzbin.com/DTD/2003/nzb',
    })
      .com(`joyn-url:${videoUrl}`)
      .com(`joyn-title:${title}`)
      .ele('head')
        .ele('meta', { type: 'title' }).txt(title).up()
      .up()
      .ele('file', {
        poster: 'JoynArr <joyn@joyn.de>',
        date: String(Math.floor(Date.now() / 1000)),
        subject: `${title} (1/1)`,
      })
        .ele('groups')
          .ele('group').txt('alt.binaries.joyn').up()
        .up()
        .ele('segments')
          .ele('segment', { bytes: '1', number: '1' }).txt('fake-segment-joyn@joyn.de').up()
        .up()
      .up()
    .up();

  return doc.end({ prettyPrint: true });
}

/**
 * Build the URL for the fake NZB download endpoint that the indexer exposes.
 * Both videoUrl and title are base64url-encoded to survive URL transmission.
 */
export function encodedNzbDownloadUrl(baseUrl: string, videoUrl: string, title: string): string {
  const encodedUrl = Buffer.from(videoUrl).toString('base64url');
  const encodedTitle = Buffer.from(title).toString('base64url');
  return `${baseUrl}/api/fake_nzb_download?encodedUrl=${encodedUrl}&encodedTitle=${encodedTitle}`;
}
