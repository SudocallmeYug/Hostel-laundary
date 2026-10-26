import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { Request } from "express";
import {
  db,
  laundryBookingsTable,
  laundryDutyAssignmentsTable,
  laundryDutyShiftsTable,
  laundryHandoversTable,
  laundryMachinesTable,
  laundryStudentsTable,
} from "@workspace/db";
import { getAuth } from "@clerk/express";
import { getAppRole, getClerkUserId } from "../middlewares/auth";

const INDIA_TIME_ZONE = "Asia/Kolkata";
const HALF_HOUR_MS = 30 * 60 * 1000;

export function indiaDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekday(day: string): number {
  return new Date(`${day}T12:00:00.000Z`).getUTCDay();
}

export function getUpcomingSaturday(): string {
  const today = indiaDate();
  return addDays(today, (6 - weekday(today) + 7) % 7);
}

export function getSaturdayForDate(day: string): string | null {
  const dayOfWeek = weekday(day);
  if (dayOfWeek === 6) return day;
  if (dayOfWeek === 0) return addDays(day, -1);
  return null;
}

export function indiaDateTime(day: string, minutesAfterMidnight: number): Date {
  const dayOffset = Math.floor(minutesAfterMidnight / (24 * 60));
  const minutes = minutesAfterMidnight % (24 * 60);
  const actualDay = addDays(day, dayOffset);
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mins = String(minutes % 60).padStart(2, "0");
  return new Date(`${actualDay}T${hours}:${mins}:00+05:30`);
}

export async function ensureStudentForRequest(req: Request) {
  const clerkUserId = getClerkUserId(req);
  const claims = getAuth(req).sessionClaims as
    | Record<string, unknown>
    | undefined;
  const nameFromClaims =
    typeof claims?.name === "string"
      ? claims.name
      : [claims?.first_name, claims?.last_name]
          .filter((value): value is string => typeof value === "string")
          .join(" ");
  const metadata =
    claims?.publicMetadata ??
    claims?.public_metadata ??
    claims?.metadata;
  const roomFromClaims =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).room
      : undefined;
  const role = getAppRole(req);

  const [existing] = await db
    .select()
    .from(laundryStudentsTable)
    .where(eq(laundryStudentsTable.clerkUserId, clerkUserId))
    .limit(1);

  if (!existing) {
    const [created] = await db
      .insert(laundryStudentsTable)
      .values({
        clerkUserId,
        name: nameFromClaims?.trim() || "Student",
        room:
          typeof roomFromClaims === "string" && roomFromClaims.trim()
            ? roomFromClaims.trim()
            : "Not set",
        role,
      })
      .returning();
    return created;
  }

  if (existing.role !== role) {
    const [updated] = await db
      .update(laundryStudentsTable)
      .set({ role })
      .where(eq(laundryStudentsTable.id, existing.id))
      .returning();
    return updated;
  }

  return existing;
}

export async function ensureMachines() {
  await db
    .insert(laundryMachinesTable)
    .values([{ name: "Washer 01" }, { name: "Washer 02" }])
    .onConflictDoNothing();
  return db
    .select()
    .from(laundryMachinesTable)
    .where(eq(laundryMachinesTable.isActive, true))
    .orderBy(asc(laundryMachinesTable.id));
}

export async function ensureWeekendSchedule(saturday: string) {
  const shifts = [0, 1].flatMap((dayOffset) => {
    const day = addDays(saturday, dayOffset);
    return Array.from({ length: 36 }, (_, index) => {
      const startMinutes = 8 * 60 + index * 30;
      return {
        startAt: indiaDateTime(day, startMinutes),
        endAt: indiaDateTime(day, startMinutes + 30),
      };
    });
  });

  await db
    .insert(laundryDutyShiftsTable)
    .values(shifts)
    .onConflictDoNothing();

  const scheduleEnd = indiaDateTime(addDays(saturday, 2), 2 * 60);
  const storedShifts = await db
    .select()
    .from(laundryDutyShiftsTable)
    .where(
      and(
        gte(laundryDutyShiftsTable.startAt, indiaDateTime(saturday, 8 * 60)),
        lt(laundryDutyShiftsTable.startAt, scheduleEnd),
      ),
    )
    .orderBy(asc(laundryDutyShiftsTable.startAt));

  const handovers = [];
  for (let index = 0; index < storedShifts.length - 1; index += 1) {
    const current = storedShifts[index];
    const next = storedShifts[index + 1];
    const gap = next.startAt.getTime() - current.endAt.getTime();
    if (gap === 0 || gap === 6 * 60 * 60 * 1000) {
      handovers.push({ fromShiftId: current.id, toShiftId: next.id });
    }
  }

  if (handovers.length) {
    await db.insert(laundryHandoversTable).values(handovers).onConflictDoNothing();
  }
}

export async function ensureUpcomingSchedules() {
  const firstSaturday = getUpcomingSaturday();
  const weekends = [firstSaturday, addDays(firstSaturday, 7), addDays(firstSaturday, 14)];
  for (const saturday of weekends) {
    await ensureWeekendSchedule(saturday);
  }
  return weekends;
}

export async function assignUpcomingDuty(studentId: number): Promise<void> {
  const weekends = await ensureUpcomingSchedules();
  const firstStart = indiaDateTime(weekends[0], 8 * 60);
  const lastEnd = indiaDateTime(addDays(weekends[weekends.length - 1], 2), 2 * 60);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4291041)`);
    const [alreadyAssigned] = await tx
      .select({ id: laundryDutyAssignmentsTable.id })
      .from(laundryDutyAssignmentsTable)
      .innerJoin(
        laundryDutyShiftsTable,
        eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
      )
      .where(
        and(
          eq(laundryDutyAssignmentsTable.studentId, studentId),
          gt(laundryDutyShiftsTable.endAt, now),
          gte(laundryDutyShiftsTable.startAt, firstStart),
          lt(laundryDutyShiftsTable.startAt, lastEnd),
        ),
      )
      .limit(1);

    if (alreadyAssigned) return;

    const shifts = await tx
      .select()
      .from(laundryDutyShiftsTable)
      .where(
        and(
          gt(laundryDutyShiftsTable.startAt, now),
          gte(laundryDutyShiftsTable.startAt, firstStart),
          lt(laundryDutyShiftsTable.startAt, lastEnd),
        ),
      )
      .orderBy(asc(laundryDutyShiftsTable.startAt));
    const assignments = await tx
      .select({ shiftId: laundryDutyAssignmentsTable.shiftId })
      .from(laundryDutyAssignmentsTable);
    const counts = new Map<number, number>();
    for (const assignment of assignments) {
      counts.set(assignment.shiftId, (counts.get(assignment.shiftId) ?? 0) + 1);
    }
    const bookings = await tx
      .select({
        startAt: laundryBookingsTable.startAt,
        endAt: laundryBookingsTable.endAt,
      })
      .from(laundryBookingsTable)
      .where(
        and(
          eq(laundryBookingsTable.studentId, studentId),
          eq(laundryBookingsTable.status, "upcoming"),
          gt(laundryBookingsTable.endAt, now),
        ),
      );

    const candidates = shifts
      .map((shift, index) => ({
        shift,
        assigned: counts.get(shift.id) ?? 0,
        dayIndex: Math.floor(index / 36),
        timeIndex: index % 36,
      }))
      .filter(
        ({ shift, assigned }) =>
          assigned < 2 &&
          !bookings.some(
            (booking) =>
              booking.startAt < shift.endAt && booking.endAt > shift.startAt,
          ),
      )
      .sort((left, right) => {
        if (left.assigned !== right.assigned) {
          return left.assigned - right.assigned;
        }
        if (left.dayIndex !== right.dayIndex) {
          return left.dayIndex - right.dayIndex;
        }
        const rank = (index: number) =>
          index % 2 === 0 ? index * 2 : 36 - index;
        return rank(left.timeIndex) - rank(right.timeIndex);
      });

    const chosen = candidates[0];
    if (!chosen) return;

    await tx
      .insert(laundryDutyAssignmentsTable)
      .values({ shiftId: chosen.shift.id, studentId })
      .onConflictDoNothing();
  });
}

export function statusForTime(
  startAt: Date,
  endAt: Date,
  completed: boolean,
  missed = false,
): "upcoming" | "active" | "completed" | "missed" {
  const now = new Date();
  if (completed) return "completed";
  if (missed) return "missed";
  if (startAt <= now && endAt > now) return "active";
  return "upcoming";
}

export async function getDutyViews(studentId: number) {
  const historyFloor = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      assignment: laundryDutyAssignmentsTable,
      shift: laundryDutyShiftsTable,
    })
    .from(laundryDutyAssignmentsTable)
    .innerJoin(
      laundryDutyShiftsTable,
      eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
    )
    .where(
      and(
        eq(laundryDutyAssignmentsTable.studentId, studentId),
        gte(laundryDutyShiftsTable.endAt, historyFloor),
      ),
    )
    .orderBy(asc(laundryDutyShiftsTable.startAt));

  return Promise.all(
    rows.map(async ({ assignment, shift }) => {
      const [partner] = await db
        .select({ name: laundryStudentsTable.name })
        .from(laundryDutyAssignmentsTable)
        .innerJoin(
          laundryStudentsTable,
          eq(laundryDutyAssignmentsTable.studentId, laundryStudentsTable.id),
        )
        .where(
          and(
            eq(laundryDutyAssignmentsTable.shiftId, shift.id),
            sql`${laundryDutyAssignmentsTable.studentId} <> ${studentId}`,
          ),
        )
        .limit(1);

      const [incomingHandover] = await db
        .select({ confirmed: laundryHandoversTable.incomingConfirmed })
        .from(laundryHandoversTable)
        .where(eq(laundryHandoversTable.toShiftId, shift.id))
        .limit(1);
      const [outgoingHandover] = await db
        .select({ confirmed: laundryHandoversTable.outgoingConfirmed })
        .from(laundryHandoversTable)
        .where(eq(laundryHandoversTable.fromShiftId, shift.id))
        .limit(1);

      const incomingConfirmed = incomingHandover?.confirmed ?? true;
      const outgoingConfirmed = outgoingHandover?.confirmed ?? true;
      const handoversComplete = incomingConfirmed && outgoingConfirmed;
      const checkedIn = assignment.checkedInAt !== null;
      const isOver = shift.endAt <= new Date();
      const status = statusForTime(
        shift.startAt,
        shift.endAt,
        isOver && checkedIn && handoversComplete,
        isOver && !(checkedIn && handoversComplete),
      );

      return {
        id: assignment.id,
        startAt: shift.startAt,
        endAt: shift.endAt,
        status,
        partnerName: partner?.name ?? "Waiting for a second supervisor",
        room: "Laundry room",
        incomingConfirmed,
        outgoingConfirmed,
      };
    }),
  );
}

export async function getProfileView(student: {
  id: number;
  name: string;
  room: string;
  role: string;
}) {
  const duties = await getDutyViews(student.id);
  const dutiesCompleted = duties.filter((duty) => duty.status === "completed").length;
  const dutiesOutstanding = duties.filter(
    (duty) =>
      duty.status !== "completed" &&
      duty.status !== "missed" &&
      duty.startAt > new Date(),
  ).length;
  return {
    id: String(student.id),
    name: student.name,
    room: student.room,
    role: student.role === "manager" ? "manager" : "student",
    dutiesCompleted,
    dutiesOutstanding,
  } as const;
}

export function dateStringFromQuery(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

export function bookingsForStudent(studentId: number) {
  return db
    .select({
      booking: laundryBookingsTable,
      machineName: laundryMachinesTable.name,
    })
    .from(laundryBookingsTable)
    .innerJoin(
      laundryMachinesTable,
      eq(laundryBookingsTable.machineId, laundryMachinesTable.id),
    )
    .where(eq(laundryBookingsTable.studentId, studentId))
    .orderBy(asc(laundryBookingsTable.startAt));
}

export async function getBookingViews(studentId: number) {
  const bookings = await bookingsForStudent(studentId);
  return bookings.map(({ booking, machineName }) => ({
    id: booking.id,
    startAt: booking.startAt,
    endAt: booking.endAt,
    machineId: booking.machineId,
    machineName,
    status:
      booking.status === "cancelled"
        ? "cancelled"
        : statusForTime(
            booking.startAt,
            booking.endAt,
              booking.status === "completed" || booking.endAt <= new Date(),
          ),
  }));
}

export async function isWeekendDay(day: string): Promise<boolean> {
  return weekday(day) === 6 || weekday(day) === 0;
}
