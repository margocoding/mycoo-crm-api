/*
  Warnings:

  - A unique constraint covering the columns `[orderId]` on the table `payment_orders` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_orderId_key" ON "payment_orders"("orderId");
