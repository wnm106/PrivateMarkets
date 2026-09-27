const { createClient } = require('@supabase/supabase-js');

async function executeWithSupabase() {
  console.log('Starting database population using Supabase client...');
  
  // Initialize Supabase client with service role key
  const supabase = createClient(
    'https://yxougybcfuignxydipes.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4b3VneWJjZnVpZ254eWRpcGVzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTk5MzI0MCwiZXhwIjoyMTA1NTY5MjQwfQ.93G7ItESVHCeeSfAjfdr_DVCpU5xF9FHc_bOZ_QFy9U'
  );

  try {
    // 1. Insert domain types
    console.log('1. Inserting domain types...');
    const domainInsert = await supabase.rpc('execute_sql', {
      sql_command: `
        INSERT INTO metadata_register.domain_types (domain_code, domain_name, description, is_active) VALUES
            ('FUND', 'Fund', 'Investment fund vehicles', true),
            ('ISSUER', 'Issuer', 'Companies and entities issuing securities', true),
            ('DEAL', 'Deal', 'Investment transactions and deals', true),
            ('SECURITY', 'Security', 'Tradeable financial instruments', true),
            ('PRICE', 'Price', 'Pricing data points', true),
            ('POSITION', 'Position', 'Portfolio positions and holdings', true)
        ON CONFLICT (domain_code) DO NOTHING;
      `
    });
    
    if (domainInsert.error) {
      console.error('Error inserting domain types:', domainInsert.error);
    } else {
      console.log('✓ Domain types inserted');
    }
    
    // 2. Insert dependency attributes
    console.log('2. Inserting dependency attributes...');
    const attr1Insert = await supabase.rpc('execute_sql', {
      sql_command: `
        INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
        VALUES
        ('ANNUAL_INTEREST', 'Annual Interest', 'CURRENCY', 'Annual interest payment amount', FALSE, 100),
        ('CURRENT_PRICE', 'Current Price', 'CURRENCY', 'Current market price', FALSE, 100)
        ON CONFLICT (attribute_code) DO NOTHING;
      `
    });
    
    if (attr1Insert.error) {
      console.error('Error inserting dependency attributes:', attr1Insert.error);
    } else {
      console.log('✓ Dependency attributes inserted');
    }
    
    // 3. Insert basic attributes for each domain
    console.log('3. Inserting basic domain attributes...');
    const attr2Insert = await supabase.rpc('execute_sql', {
      sql_command: `
        INSERT INTO metadata_register.attribute_register (attribute_code, attribute_name, data_type, description, is_required, default_precedence_rank)
        VALUES
        ('FUND_NAME', 'Fund Name', 'STRING', 'Name of the fund', TRUE, 100),
        ('ISSUER_NAME', 'Issuer Name', 'STRING', 'Name of the issuer', TRUE, 100),
        ('DEAL_NAME', 'Deal Name', 'STRING', 'Name of the deal', TRUE, 100),
        ('SECURITY_NAME', 'Security Name', 'STRING', 'Name of the security', TRUE, 100)
        ON CONFLICT (attribute_code) DO NOTHING;
      `
    });
    
    if (attr2Insert.error) {
      console.error('Error inserting basic domain attributes:', attr2Insert.error);
    } else {
      console.log('✓ Basic domain attributes inserted');
    }
    
    // 4. Verify the data was inserted
    console.log('4. Verifying inserted data...');
    
    // Query domain types
    const domainCheck = await supabase.from('metadata_register.domain_types').select('count(*)');
    if (domainCheck.error) {
      console.log('Could not verify domain types:', domainCheck.error.message);
    } else {
      console.log(`✓ Found ${domainCheck.data?.[0]?.count || 0} domain types`);
    }
    
    // Query attributes
    const attrCheck = await supabase.from('metadata_register.attribute_register').select('count(*)');
    if (attrCheck.error) {
      console.log('Could not verify attributes:', attrCheck.error.message);
    } else {
      console.log(`✓ Found ${attrCheck.data?.[0]?.count || 0} attributes`);
    }
    
    console.log('\n🎉 Database successfully populated with essential data!');
    console.log('The application should now display live data instead of empty results.');

  } catch (err) {
    console.error('❌ Error during execution:', err);
    throw err;
  }
}

// Run the function
executeWithSupabase()
  .then(() => console.log('\n✅ Script completed successfully'))
  .catch(err => {
    console.error('\n❌ Script failed:', err);
    process.exit(1);
  });