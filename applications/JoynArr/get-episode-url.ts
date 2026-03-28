import { getLatestEpisodes } from './src/services/joyn.js';

// Get a sample episode URL to test in browser
async function main() {
  console.log('Fetching latest episodes...');
  const episodes = await getLatestEpisodes(5);

  if (episodes.length > 0) {
    const ep = episodes[0];
    console.log('\n=== Episode Found ===');
    console.log('Show:', ep.showTitle);
    console.log('Title:', ep.title);
    console.log('Season:', ep.season);
    console.log('Episode:', ep.episode);
    console.log('Episode ID:', ep.id);
    console.log('Stream URL:', ep.streamUrl);
    console.log('\n=== Open this URL in Chrome with DevTools: ===');
    console.log(ep.streamUrl);
  } else {
    console.log('No episodes found');
  }
}

main().catch(console.error);
