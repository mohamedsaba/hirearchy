ALTER TABLE hirearchy.application_principals
  ADD COLUMN avatar_webp pg_catalog.text
  CHECK (
    avatar_webp IS NULL OR (
      pg_catalog.length(avatar_webp) BETWEEN 16 AND 24000
      AND avatar_webp ~ '^UklGR[A-Za-z0-9+/]+={0,2}$'
    )
  );
