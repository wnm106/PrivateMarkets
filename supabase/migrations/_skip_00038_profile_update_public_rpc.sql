-- Migration: Profile Update RPC (Public Wrapper)
-- Description: Public-facing RPC function that wraps the tenancy schema function.
-- Supabase's .rpc() looks in the public schema by default, so we need a wrapper here.

CREATE OR REPLACE FUNCTION public.update_profile_display_name(
    p_user_id UUID,
    p_display_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, public
AS $$
BEGIN
    RETURN tenancy.update_profile_display_name(p_user_id, p_display_name);
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.update_profile_display_name(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_profile_display_name(UUID, TEXT) TO anon;