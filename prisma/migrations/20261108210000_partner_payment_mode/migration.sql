-- Existing checkout links were always created with IsTest=1. Keep them classified
-- as tests so switching the gateway to live mode cannot create payable commission.
ALTER TABLE "payment_orders" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT true;
