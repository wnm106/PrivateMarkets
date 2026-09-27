const { Pool } = require('pg');
require('dotenv').config();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.yxougybcfuignxydipes:Pr%21vateM%40rkets@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
  ssl: {
    rejectUnauthorized: false
  },
  max: 1 // Only one connection at a time
});

async function executeSequentially() {
  console.log('Starting sequential database population...');
  
  try {
    // 1. Insert domain types
    console.log('1. Inserting domain types...');
    const client = await pool.connect();
    
    await client.query(`
      INSERT INTO metadata_register.domain_types (domain_code, domain_name, description, is_active) VALUES
          ('FUND', 'Fund', 'Investment fund vehicles', true),
          ('ISSUER', 'Issuer', 'Companies and entities issuing securities', true),
          ('DEAL', 'Deal', 'Investment transactions and deals', true),
          ('SECURITY', 'Security', 'Tradeable financial instruments', true),
          ('PRICE', 'Price', 'Pricing data points', true),
          ('POSITION', 'Position', 'Portfolio positions and holdings', true)
      ON CONFLICT (domain_code) DO NOTHING;
    `);
    console.log('✓ Domain types inserted');
    
    // 2. Insert dependency attributes
    console.log('2. Inserting dependency attributes...');
    await client.query(`
      INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
      VALUES
      ('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
      ('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
      ON CONFLICT (attribute_code) DO NOTHING;
    `);
    console.log('✓ Dependency attributes inserted');
    
    // 3. Insert basic attributes for each domain
    console.log('3. Inserting basic domain attributes...');
    await client.query(`
      INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
      VALUES
      ('FUND_NAME', 'Fund Name', 'STRING', 'Name of the fund', TRUE, 100),
      ('ISSUER_NAME', 'Issuer Name', 'STRING', 'Name of the issuer', TRUE, 100),
      ('DEAL_NAME', 'Deal Name', 'STRING', 'Name of the deal', TRUE, 100),
      ('SECURITY_NAME', 'Security Name', 'STRING', 'Name of the security', TRUE, 100)
      ON CONFLICT (attribute_code) DO NOTHING;
    `);
    console.log('✓ Basic domain attributes inserted');
    
    // 4. Verify the data was inserted
    console.log('4. Verifying inserted data...');
    
    const domainTypes = await client.query('SELECT COUNT(*) FROM metadata_register.domain_types;');
    console.log(`✓ Found ${domainTypes.rows[0].count} domain types`);
    
    const attributes = await client.query('SELECT COUNT(*) FROM metadata_register.attribute_register;');
    console.log(`✓ Found ${attributes.rows[0].count} attributes`);
    
    console.log('\n🎉 Database successfully populated with essential data!');
    console.log('The application should now display live data instead of empty results.');
    
    client.release();
  } catch (err) {
    console.error('❌ Error during sequential execution:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

// Run the function
executeSequentially()
  .then(() => console.log('\n✅ Script completed successfully'))
  .catch(err => {
    console.error('\n❌ Script failed:', err);
    process.exit(1);
  });