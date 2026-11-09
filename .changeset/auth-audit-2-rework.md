---
"@arki/auth": patch
---

`IntegrationTester.clearTables`, `clearAllTables`, `clearTablesExcept` and `clearTablesByPattern` delete a child table before the parents it references. They deleted in schema export order, so a parent exported before a child that held rows was refused by the foreign key (SQLSTATE 23503). Tables in a foreign-key cycle keep their given order.
