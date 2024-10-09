const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');

const terms = [
    "Transcriptome", "Gene Expression"
];

const institutions = ['Brown University', 'Yale University', 'Harvard University'];

const yearRange = {
    start: 2020,
    end: 2024
};

const baseUrl = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const searchUrl = `${baseUrl}esearch.fcgi`;
const fetchUrl = `${baseUrl}efetch.fcgi`;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(url, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        params,
        timeout: 30000 // 30 seconds timeout
      });
      return response;
    } catch (error) {
      console.error(`Attempt ${i + 1} failed: ${error.message}`);
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1)); // Exponential backoff
    }
  }
}

async function fetchAndProcessBatch(queryKey, webEnv, start, batchSize) {
  const fetchResponse = await makeRequest(fetchUrl, {
    db: 'pubmed',
    query_key: queryKey,
    WebEnv: webEnv,
    retmode: 'xml',
    rettype: 'abstract',
    retstart: start,
    retmax: batchSize
  });

  const fetchResult = await xml2js.parseStringPromise(fetchResponse.data);
  
  if (!fetchResult.PubmedArticleSet || !fetchResult.PubmedArticleSet.PubmedArticle) {
    console.log(`No articles found in fetch result for batch starting at ${start}`);
    return [];
  }

  return fetchResult.PubmedArticleSet.PubmedArticle.map(article => {
    const citation = article.MedlineCitation[0];
    const affiliation = citation.Article[0].AuthorList[0].Author[0].AffiliationInfo ?
      citation.Article[0].AuthorList[0].Author[0].AffiliationInfo[0].Affiliation[0] : '';
    
    const pubDate = citation.Article[0].Journal[0].JournalIssue[0].PubDate[0];
    const pubYear = pubDate.Year ? parseInt(pubDate.Year[0]) : null;

    // Only include if affiliation matches and year is within range
    if (institutions.some(inst => affiliation.includes(inst)) &&
        pubYear >= yearRange.start && pubYear <= yearRange.end) {
      return {
        pmid: citation.PMID[0]._,
        title: citation.Article[0].ArticleTitle[0],
        abstract: citation.Article[0].Abstract ? citation.Article[0].Abstract[0].AbstractText[0]._ : 'No abstract available',
        authors: citation.Article[0].AuthorList ? citation.Article[0].AuthorList[0].Author.map(author => 
          `${author.LastName ? author.LastName[0] : ''} ${author.ForeName ? author.ForeName[0] : ''}`
        ) : ['No authors listed'],
        journal: citation.Article[0].Journal[0].Title[0],
        publicationDate: pubYear,
        affiliation: affiliation
      };
    }
    return null;
  }).filter(Boolean); // Remove null entries
}

async function searchPubMed(term) {
    console.log(`Searching for term: ${term}`);
    try {
      const dateRange = `${yearRange.start}:${yearRange.end}[dp]`;
      const searchTerm = `(${term}) AND (${institutions.join(' OR ')}) AND ${dateRange}`;
      const searchResponse = await makeRequest(searchUrl, {
        db: 'pubmed',
        term: searchTerm,
        usehistory: 'y',
      });

      console.log(`Received search response for term: ${searchTerm}`);
      const searchResult = await xml2js.parseStringPromise(searchResponse.data);
      const count = parseInt(searchResult.eSearchResult.Count[0]);
      console.log(`Found ${count} results for term: ${searchTerm}`);
      
      if (count === 0) {
        console.log(`No results found for term: ${searchTerm}`);
        return [];
      }

      const queryKey = searchResult.eSearchResult.QueryKey[0];
      const webEnv = searchResult.eSearchResult.WebEnv[0];

      let allResults = [];
      const batchSize = 100;
      for (let start = 0; start < count; start += batchSize) {
        console.log(`Fetching batch starting at ${start} for term: ${searchTerm}`);
        const batchResults = await fetchAndProcessBatch(queryKey, webEnv, start, batchSize);
        allResults = allResults.concat(batchResults);
        console.log(`Processed ${batchResults.length} results in this batch`);
        await delay(334); // Respect NCBI's rate limit
      }

      return allResults;
    } catch (error) {
      console.error(`Error searching for term "${term}":`, error.message);
      return [];
    }
  }

async function main() {
  let allResults = [];

  for (const term of terms) {
    try {
      const results = await searchPubMed(term);
      allResults = allResults.concat(results);
      console.log(`Processed ${results.length} total results for term: ${term}`);
      await delay(334);
    } catch (error) {
      console.error(`Error processing term "${term}":`, error.message);
    }
  }

  const uniqueResults = Array.from(new Set(allResults.map(a => a.pmid)))
    .map(pmid => allResults.find(a => a.pmid === pmid));

  console.log(`Total unique results: ${uniqueResults.length}`);
  
  // Write results to ore.json
  fs.writeFile('ore.json', JSON.stringify(uniqueResults, null, 2), (err) => {
    if (err) {
      console.error("Error writing to file:", err);
    } else {
      console.log("Results have been written to ore.json");
    }
  });
}

main().catch(error => {
  console.error("An error occurred in the main function:", error.message);
});
