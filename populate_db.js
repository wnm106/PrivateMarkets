const { createClient } = require('@supabase/supabase-js');

async function populateDatabase() {
  // Get database URL from environment
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres.yxougybcfuignxydipes:Pr%21vateM%40rkets@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
  
  // Initialize Supabase client
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://yxougybcfuignxydipes.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4b3VneWJjZnVpZ254eWRpcGVzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTk5MzI0MCwiZXhwIjoyMTA1NTY5MjQwfQ.93G7ItESVHCeeSfAjfdr_DVCpU5xF9FHc_bOZ_QFy9U'
  );

  console.log('Populating database with domain types...');

  try {
    // Execute the SQL directly
    const { data, error } = await supabase.rpc('execute_sql', {
      sql_command: `
        INSERT INTO metadata_register.domain_types (domain_code, domain_name, description, is_active) VALUES
            ('FUND', 'Fund', 'Investment fund vehicles', true),
            ('ISSUER', 'Issuer', 'Companies and entities issuing securities', true),
            ('DEAL', 'Deal', 'Investment transactions and deals', true),
            ('SECURITY', 'Security', 'Tradeable financial instruments', true),
            ('PRICE', 'Price', 'Pricing data points', true),
            ('POSITION', 'Position', 'Portfolio positions and holdings', true)
        ON CONFLICT (domain_code) DO NOTHING;

        INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
        VALUES
        ('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
        ('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
        ON CONFLICT (attribute_code) DO NOTHING;

        INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
        VALUES
        ('FUND_NAME', 'Fund Name', 'STRING', 'Name of the fund', TRUE, 100),
        ('ISSUER_NAME', 'Issuer Name', 'STRING', 'Name of the issuer', TRUE, 100),
        ('DEAL_NAME', 'Deal Name', 'STRING', 'Name of the deal', TRUE, 100),
        ('SECURITY_NAME', 'Security Name', 'STRING', 'Name of the security', TRUE, 100)
        ON CONFLICT (attribute_code) DO NOTHING;
      `
    });

    if (error) {
      console.error('Error executing SQL:', error);
      return;
    }

    console.log('Successfully populated domain types and basic attributes!');
  } catch (err) {
    console.error('Error:', err);
  }
}

// Alternative approach using raw SQL via Supabase
async function populateWithRawSql() {
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.yxougybcfuignxydipes:Pr%21vateM%40rkets@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    ssl: {
      rejectUnauthorized: false
    }
  });

  const sql = `
    INSERT INTO metadata_register.domain_types (domain_code, domain_name, description, is_active) VALUES
        ('FUND', 'Fund', 'Investment fund vehicles', true),
        ('ISSUER', 'Issuer', 'Companies and entities issuing securities', true),
        ('DEAL', 'Deal', 'Investment transactions and deals', true),
        ('SECURITY', 'Security', 'Tradeable financial instruments', true),
        ('PRICE', 'Price', 'Pricing data points', true),
        ('POSITION', 'Position', 'Portfolio positions and holdings', true)
    ON CONFLICT (domain_code) DO NOTHING;

    INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
    VALUES
    ('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
    ('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
    ON CONFLICT (attribute_code) DO NOTHING;

    INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
    VALUES
    ('FUND_NAME', 'Fund Name', 'STRING', 'Name of the fund', TRUE, 100),
    ('ISSUER_NAME', 'Issuer Name', 'STRING', 'Name of the issuer', TRUE, 100),
    ('DEAL_NAME', 'Deal Name', 'STRING', 'Name of the deal', TRUE, 100),
    ('SECURITY_NAME', 'Security Name', 'STRING', 'Name of the security', TRUE, 100)
    ON CONFLICT (attribute_code) DO NOTHING;
  `;

  try {
    const client = await pool.connect();
    await client.query(sql);
    client.release();
    console.log('Successfully populated database via raw SQL!');
  } catch (err) {
    console.error('Error with raw SQL:', err);
  } finally {
    await pool.end();
  }
}

// Run the function
populateWithRawSql().catch(console.error);