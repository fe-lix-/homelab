import { buildCapsXml } from '../utils/xml.js';

/**
 * Return the Newznab caps XML, describing the capabilities of this indexer.
 */
export function buildCapsResponse(): string {
  return buildCapsXml();
}
