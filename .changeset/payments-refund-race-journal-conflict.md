---
'@arki/payments': patch
---

`RefundService.requestRefund` returns `DuplicatePendingRefund` again when two requests for one payment race. The journal now reports a row insert's unique violation as `JournalError('CONFLICT')`, so the losing write came back as `TransactionDefect` and reached the caller as a defect. The service now knows the race in that shape too, and still in the `TransactionRejected` 23505 shape from a plain database write.

no docs impact: behaviour fix; the documented failure is unchanged.
no demo impact: no demo covers refund races.
