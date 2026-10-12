require('dotenv').config();

async function testGoldenSource() {
  // Test with the entity ID from earlier that should have source values
  const entityId = "67fef3ad-b350-4038-8634-e9b63816c0aa";
  
  const query = `
    {
      evaluateGoldenSource(
        entityId: "${entityId}"
        attributeCode: "PRICE"
        domainCode: "SECURITY"
      ) {
        winningSource
        tierUsed
        isDefault
        resolutionVersion
        appliedRuleCode
        allCandidates
      }
    }
  `;

  try {
    console.log('Testing golden source evaluation for entity:', entityId);
    console.log('Attribute: PRICE, Domain: SECURITY\n');
    
    const res = await fetch('http://localhost:4000/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ query })
    });

    const data = await res.json();
    console.log('Golden Source Evaluation Result:');
    console.log(JSON.stringify(data, null, 2));

    if (data.data?.evaluateGoldenSource) {
      const result = data.data.evaluateGoldenSource;
      console.log('\n=== Analysis ===');
      console.log(`Winning Source: ${result.winningSource}`);
      console.log(`Tier Used: ${result.tierUsed} (${
        result.tierUsed === 1 ? 'Manual Override' :
        result.tierUsed === 2 ? 'Template-Scoped Conditional Rule' :
        result.tierUsed === 3 ? 'Template Default Chain' :
        'Global Source Registry Fallback'
      })`);
      console.log(`Is Default: ${result.isDefault}`);
      console.log(`Resolution Version: ${result.resolutionVersion}`);
      console.log(`Applied Rule: ${result.appliedRuleCode || 'None'}`);
      console.log(`Candidates Found: ${result.allCandidates?.length || 0}`);
      
      if (result.allCandidates && result.allCandidates.length > 0) {
        console.log('\nCompeting Sources:');
        result.allCandidates.forEach((c, i) => {
          console.log(`  ${i + 1}. ${c.source}: ${c.value} (rank: ${c.rank})`);
        });
      }
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testGoldenSource();





