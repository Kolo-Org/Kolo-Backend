# Kolo - PRD (Product Requirement Document)

## 1. Product Overview

**Name:** Kolo

**Type:** WhatsApp-Native Savings & Payments Platform

**Platform:** WhatsApp + Node.js Backend + Stellar Blockchain + Soroban Smart Contracts

**Objective:**
Enable individuals, families, and community savings groups to create, manage, and participate in digital savings circles directly through WhatsApp, with transparent contributions and automated payouts powered by Stellar.

**Target Users:**

* Ajo/Esusu groups
* Community cooperatives
* Family savings groups
* Students
* Informal financial associations
* Small business contribution clubs

---

## 2. Features

### 2.1 User Features

* Register using WhatsApp phone number
* Automatically create Stellar wallet
* Check wallet balance
* Send and receive USDC
* View transaction history
* Receive payment notifications

### 2.2 Savings Group Features

* Create savings groups
* Invite members through WhatsApp
* Join groups via invitation
* Define contribution amount
* Define contribution frequency
* Track member contributions
* View group savings progress
* Automated contribution reminders
* Automated payout distribution

### 2.3 Admin Features

* Monitor platform activity
* View active groups
* Manage users
* Review transaction logs
* Handle dispute reports
* Monitor smart contract performance

---

## 3. Technical Architecture

### Components

#### WhatsApp Interface

Provides user interaction through:

* Commands
* Interactive buttons
* Notifications
* Group invitations

#### WhatsApp Business API

Handles:

* Message delivery
* User communication
* Event webhooks

#### Node.js Backend

Responsible for:

* User management
* Wallet management
* Group management
* Transaction processing
* Smart contract interaction

#### Soroban Smart Contracts

Handles:

* Savings group creation
* Contribution tracking
* Payout execution
* Group state management

#### Stellar Blockchain

Provides:

* Settlement layer
* USDC transfers
* Transaction validation

#### Database

Stores:

* User profiles
* Group metadata
* Transaction records
* Contribution history

---

### Flow

```mermaid
graph TD
    A[User sends message on WhatsApp] --> B[WhatsApp Business API receives request]
    B --> C[Node.js backend processes command]
    C --> D[Backend interacts with Soroban smart contract]
    D --> E[Soroban updates group state]
    E --> F[Stellar executes transaction]
    F --> G[Backend returns confirmation to WhatsApp]
    G --> H[User receives notification]
```

---

### Example Savings Flow

```mermaid
graph TD
    A[Group Creator creates group] --> B[Members receive invitations]
    B --> C[Members join group]
    C --> D[Members contribute USDC]
    D --> E[Contributions recorded in contract]
    E --> F[Contribution status updated]
    F --> G[Payout date reached]
    G --> H[Soroban contract triggers payout]
    H --> I[Recipient receives funds]
    I --> J[Group records updated]
```

---

## 4. Tech Stack

### Frontend

* WhatsApp Business Platform
* WhatsApp Cloud API

### Backend

* Node.js
* Express.js
* TypeScript

### Database

* PostgreSQL

### Blockchain

* Stellar Network
* Soroban Smart Contracts

### Smart Contract Language

* Rust
* soroban-sdk

### Wallet Integration

* Stellar SDK

### Notifications

* WhatsApp Cloud API Webhooks


## 5. Local Development Setup

### Prerequisites

* Node.js >= 18.x
* PostgreSQL >= 14.x
* Redis (for BullMQ queue)
* npm or yarn

### Installation

```bash
git clone https://github.com/Tobi-8/Kolo-Backend.git
cd Kolo-Backend
npm install
```

### Environment Configuration

Create a `.env` file in the project root:

```env
PORT=3000
WHATSAPP_TOKEN=your_whatsapp_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_APP_SECRET=your_app_secret
VERIFY_TOKEN=kolo_verify_token
DATABASE_URL=postgresql://user:password@localhost:5432/kolo_db
STELLAR_NETWORK=TESTNET
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=your_32_byte_hex_string
```

### Database Setup

```bash
# Create PostgreSQL database
createdb kolo_db

# Run Prisma migrations
npx prisma migrate deploy

# (Optional) Seed initial data
npx prisma db seed
```

### Running the Application

```bash
# Development
npm run dev

# Production
npm start
```

---

## 6. MVP Scope

### User Registration

* WhatsApp onboarding
* Wallet creation

### Wallet Features

* Balance inquiry
* Transaction history

### Savings Groups

* Create group
* Join group
* Invite members
* Contribution tracking

### Payments

* USDC transfers
* Automated payouts

### Notifications

* Contribution reminders
* Payout confirmations

---

## 7. Future Enhancements

### Financial Features

* Rotational savings pools (Ajo/Esusu)
* Goal-based savings
* Emergency funds
* Community lending

### Payments

* Merchant payments
* Bill payments
* Airtime purchases
* Utility payments

### Growth Features

* Referral rewards
* Group leaderboards
* Savings achievements

### Asset Support

* Multiple stablecoins
* Local currency on/off ramps
* Cross-border remittances

---

## 8. Security & Compliance

### Security

* Encrypted wallet storage
* Secure webhook validation
* Transaction signing verification
* Smart contract validation
* Keep wallet generation out of logs and minimize secret lifetime in memory

### Production Hardening

When deploying wallet-generation code in production:

* Disable core dumps with `ulimit -c 0`
* Disable crash dump collection in the container runtime or host OS
* Prefer an isolated key-management service for final wallet custody
* Never log `secret` values or derived wallet payloads
* Review memory-dump settings after OS, container, and base-image upgrades

### Compliance

* Phone number verification
* KYC integration (future phase)
* AML monitoring (future phase)
* Transaction audit logs

---

## 9. Performance Considerations

* Cache frequently accessed group data
* Optimize Soroban contract storage
* Queue transaction processing
* Implement webhook retry mechanisms
* Monitor Stellar network fees

### Target Metrics

* Response time < 3 seconds
* Payment settlement < 5 seconds
* Support 10,000+ users
* Support 1,000+ active savings groups

---

## 10. Testing Plan

### Backend Testing

* Unit tests for APIs
* Wallet service tests
* Group management tests

### Smart Contract Testing

* Soroban contract unit tests
* Contribution validation tests
* Payout execution tests

### Integration Testing

Full workflow:

User Registration

↓

Wallet Creation

↓

Group Creation

↓

Member Contribution

↓

Automated Payout

↓

Transaction Verification

### Load Testing

* Concurrent user activity
* High-volume contribution periods
* Group payout events

---

## 11. Deployment Plan

### Backend

Deploy on:

* AWS
* DigitalOcean
* Railway

### Database

* PostgreSQL Managed Service

### Blockchain

* Stellar Testnet (Development)
* Stellar Mainnet (Production)

### Smart Contracts

Deploy Soroban contracts:

* Testnet
* Mainnet

### WhatsApp Integration

* WhatsApp Cloud API
* Webhook Infrastructure

### Monitoring

* Application Logs
* Stellar Transaction Monitoring
* Smart Contract Monitoring
* Error Tracking

---

## 12. Success Metrics

### User Metrics

* Registered users
* Active users
* Retention rate

### Group Metrics

* Groups created
* Active groups
* Average members per group

### Financial Metrics

* Total savings volume
* Total contribution volume
* Total payouts processed

### Platform Metrics

* Transaction success rate
* Smart contract execution success rate
* Average response time

---

## 13. Core User Commands

### Account

BALANCE

HISTORY

PROFILE

### Payments

SEND 10 @john

REQUEST 20 @mary

### Savings Groups

CREATE GROUP

JOIN GROUP

INVITE MEMBER

GROUP STATUS

CONTRIBUTE

WITHDRAW

### Help

HELP

SUPPORT
