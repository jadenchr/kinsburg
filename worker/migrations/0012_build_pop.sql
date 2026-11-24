-- City size when each build was made (highest resident number). The browser picks a build's site
-- from the neighbourhoods that existed then, so the best open spot goes first and nothing moves later.
ALTER TABLE builds ADD COLUMN pop INTEGER;
