import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const laundryStudentsTable = pgTable(
  "laundry_students",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    name: text("name").notNull().default("Student"),
    room: text("room").notNull().default("Not set"),
    role: text("role").notNull().default("student"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("laundry_students_clerk_user_id_idx").on(table.clerkUserId)],
);

export const laundryMachinesTable = pgTable(
  "laundry_machines",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [uniqueIndex("laundry_machines_name_idx").on(table.name)],
);

export const laundryBookingsTable = pgTable(
  "laundry_bookings",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id")
      .notNull()
      .references(() => laundryStudentsTable.id, { onDelete: "cascade" }),
    machineId: integer("machine_id")
      .notNull()
      .references(() => laundryMachinesTable.id),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("upcoming"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("laundry_bookings_machine_start_idx").on(
      table.machineId,
      table.startAt,
    ),
    index("laundry_bookings_student_start_idx").on(
      table.studentId,
      table.startAt,
    ),
  ],
);

export const laundryDutyShiftsTable = pgTable(
  "laundry_duty_shifts",
  {
    id: serial("id").primaryKey(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("laundry_duty_shifts_start_idx").on(table.startAt)],
);

export const laundryDutyAssignmentsTable = pgTable(
  "laundry_duty_assignments",
  {
    id: serial("id").primaryKey(),
    shiftId: integer("shift_id")
      .notNull()
      .references(() => laundryDutyShiftsTable.id, { onDelete: "cascade" }),
    studentId: integer("student_id")
      .notNull()
      .references(() => laundryStudentsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("upcoming"),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("laundry_duty_assignments_shift_student_idx").on(
      table.shiftId,
      table.studentId,
    ),
    index("laundry_duty_assignments_student_idx").on(table.studentId),
  ],
);

export const laundryHandoversTable = pgTable(
  "laundry_handovers",
  {
    id: serial("id").primaryKey(),
    fromShiftId: integer("from_shift_id")
      .notNull()
      .references(() => laundryDutyShiftsTable.id, { onDelete: "cascade" }),
    toShiftId: integer("to_shift_id")
      .notNull()
      .references(() => laundryDutyShiftsTable.id, { onDelete: "cascade" }),
    outgoingConfirmed: boolean("outgoing_confirmed").notNull().default(false),
    incomingConfirmed: boolean("incoming_confirmed").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("laundry_handovers_shift_pair_idx").on(
      table.fromShiftId,
      table.toShiftId,
    ),
  ],
);

export const laundryQrTokensTable = pgTable(
  "laundry_qr_tokens",
  {
    id: serial("id").primaryKey(),
    studentId: integer("student_id")
      .notNull()
      .references(() => laundryStudentsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    referenceId: integer("reference_id").notNull(),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("laundry_qr_tokens_token_idx").on(table.token),
    uniqueIndex("laundry_qr_tokens_reference_idx").on(
      table.studentId,
      table.kind,
      table.referenceId,
    ),
    index("laundry_qr_tokens_student_idx").on(table.studentId),
  ],
);

export const insertLaundryStudentSchema = createInsertSchema(
  laundryStudentsTable,
).omit({ id: true, createdAt: true });
export const insertLaundryMachineSchema = createInsertSchema(
  laundryMachinesTable,
).omit({ id: true });
export const insertLaundryBookingSchema = createInsertSchema(
  laundryBookingsTable,
).omit({ id: true, createdAt: true });
export const insertLaundryDutyShiftSchema = createInsertSchema(
  laundryDutyShiftsTable,
).omit({ id: true, createdAt: true });
export const insertLaundryDutyAssignmentSchema = createInsertSchema(
  laundryDutyAssignmentsTable,
).omit({ id: true, createdAt: true });
export const insertLaundryHandoverSchema = createInsertSchema(
  laundryHandoversTable,
).omit({ id: true, createdAt: true });
export const insertLaundryQrTokenSchema = createInsertSchema(
  laundryQrTokensTable,
).omit({ id: true, createdAt: true });

export type LaundryStudent = typeof laundryStudentsTable.$inferSelect;
export type InsertLaundryStudent = z.infer<typeof insertLaundryStudentSchema>;
export type LaundryMachine = typeof laundryMachinesTable.$inferSelect;
export type LaundryBooking = typeof laundryBookingsTable.$inferSelect;
export type LaundryDutyShift = typeof laundryDutyShiftsTable.$inferSelect;
export type LaundryDutyAssignment =
  typeof laundryDutyAssignmentsTable.$inferSelect;
export type LaundryHandover = typeof laundryHandoversTable.$inferSelect;
export type LaundryQrToken = typeof laundryQrTokensTable.$inferSelect;
