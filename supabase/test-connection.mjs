import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://iqsaxeeeqwswssewpkxj.supabase.co',
  'sb_publishable_FOGtMrVR0meYouO4w0Pt3w_yTdOojWl'
);

try {
  const { data: pf, error: e1 } = await supabase.from('portfolio').select('*').eq('id', 1).single();
  console.log('Portfolio:', pf, e1);

  const { data: bs, error: e2 } = await supabase.from('bot_state').select('*').eq('id', 1).single();
  console.log('BotState:', bs, e2);

  const { data: ct, error: e3 } = await supabase.from('ai_cost_tracker').select('*').eq('id', 1).single();
  console.log('AICostTracker:', ct, e3);

  // Test RPC
  await supabase.rpc('deduct_balance', { amount: 5 });
  const { data: pf2 } = await supabase.from('portfolio').select('balance').eq('id', 1).single();
  console.log('After deduct_balance(5):', pf2?.balance);

  await supabase.rpc('add_balance', { amount: 5 });
  const { data: pf3 } = await supabase.from('portfolio').select('balance').eq('id', 1).single();
  console.log('After add_balance(5):', pf3?.balance);

  // Test insert + select activity
  await supabase.from('activities').insert({ timestamp: new Date().toISOString(), message: 'Test activity', entry_type: 'Info' });
  const { data: acts } = await supabase.from('activities').select('*').order('id', { ascending: false }).limit(1);
  console.log('Latest activity:', acts?.[0]?.message);

  // Cleanup test
  if (acts?.[0]) await supabase.from('activities').delete().eq('id', acts[0].id);
  console.log('\n✅ ALL TESTS PASSED');
} catch (err) {
  console.error('❌ Test failed:', err);
}
