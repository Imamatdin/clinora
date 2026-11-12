CREATE TABLE password_login_limits (
 key text PRIMARY KEY,
 failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
 locked_until timestamptz
);
