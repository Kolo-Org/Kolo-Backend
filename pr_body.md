## Description

This PR implements the SEP-10 Challenge-Response Authentication protocol for the Kolo Backend, enabling users/clients to authenticate securely using their Stellar keypairs. 

### Core Features Added
- **JWT Authentication**: Integrated `jsonwebtoken` to sign and issue secure session tokens for authenticated clients.
- **Environment Configuration**: Added support for new environment variables (`SEP10_SERVER_SECRET`, `SEP10_HOME_DOMAIN`, `JWT_SECRET`) in `src/config/env.ts` to manage server secrets.
- **Authentication Service (`auth.service.ts`)**: Encapsulates the core SEP-10 logic utilizing `@stellar/stellar-sdk`'s `WebAuth` module:
  - `generateChallenge`: Generates a SEP-10 challenge transaction.
  - `verifyChallengeAndGenerateToken`: Validates a client's signed transaction against the threshold requirements, subsequently generating a JWT on success.
- **Controllers & Routing (`auth.controller.ts` & `auth.routes.ts`)**: 
  - `GET /auth/challenge?account=<client_public_key>`
  - `POST /auth/token` with the client's signed transaction in the body.
- **Express Middleware (`auth.middleware.ts`)**: Created the `requireAuth` middleware for easy attachment of the authenticated `account` to the incoming `Request` for protected routes.
- **Comprehensive Testing**: Added full unit test coverage mimicking the client-server interaction to ensure accurate transaction parsing and successful signature verification.

### Dependencies
- Added `jsonwebtoken`
- Added `@types/jsonwebtoken` (dev)

Closes any open authentication tracking items.
