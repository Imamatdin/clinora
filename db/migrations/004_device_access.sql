-- Task 004 (increment C1b): Telegram access, single-use invites, shared-PC devices and PIN switching.
-- Secrets (invite tokens, device tokens, PINs) are stored only as hashes.

-- One Telegram user per account and one account per Telegram user. A link is an identity
-- binding only; clinic access is still decided by memberships and roles on every request.
CREATE TABLE telegram_links (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  telegram_user_id bigint NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  linked_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use, expiring invitations to bind a Telegram account. Token stored as SHA-256.
CREATE TABLE telegram_invites (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL, account_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz, consumed_by_telegram_id bigint, revoked_at timestamptz,
  FOREIGN KEY (clinic_id, account_id) REFERENCES memberships(clinic_id, user_id),
  CHECK ((consumed_at IS NULL) = (consumed_by_telegram_id IS NULL)),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX telegram_invites_open ON telegram_invites(account_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Telegram retries webhook deliveries; an update is processed once.
CREATE TABLE telegram_updates (update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
-- Mini App init data is accepted once (replay protection inside the freshness window).
CREATE TABLE telegram_init_data_uses (hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'), expires_at timestamptz NOT NULL);
CREATE INDEX telegram_init_data_expiry ON telegram_init_data_uses(expires_at);

-- Shared clinic computers. The browser holds the raw token in an httpOnly cookie.
CREATE TABLE devices (
  id uuid PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES accounts(id), revoked_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX devices_clinic ON devices(clinic_id, created_at);

-- Per-person PIN for switching user on an enrolled device. Hashed like a password.
-- Wrong attempts count per account (never per IP); five wrong tries lock until reset.
CREATE TABLE account_pins (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((locked_at IS NOT NULL) = (failed_attempts = 5))
);

-- How a session was started. Device sessions are bound to their device and expire after idle time.
ALTER TABLE sessions ADD COLUMN via text NOT NULL DEFAULT 'password' CHECK (via IN ('password','telegram','device'));
ALTER TABLE sessions ADD COLUMN device_id uuid REFERENCES devices(id);
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD CONSTRAINT session_device_binding CHECK ((via = 'device') = (device_id IS NOT NULL));
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_device ON sessions(device_id) WHERE device_id IS NOT NULL;
