CREATE TABLE `signing_keys` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`private_jwk` text NOT NULL,
	`public_jwk` text NOT NULL
);
