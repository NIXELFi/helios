-- Pin item_cost's search_path (Supabase advisor 0011, function_search_path_mutable).
-- It only does arithmetic on the row it is given, so nothing resolves through
-- the search path; this just makes that explicit.
alter function purchasing.item_cost(purchasing.items) set search_path = '';
