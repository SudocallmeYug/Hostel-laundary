import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, gte, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CancelLaundryBookingParams,
  CompleteLaundryHandoverBody,
  CompleteLaundryHandoverResponse,
  CreateLaundryBookingBody,
  CreateLaundryBookingResponse,
  GetLaundryBookingsResponse,
  GetLaundryDashboardResponse,
  GetLaundryDutiesResponse,
  GetLaundryMeResponse,
  GetLaundryQrCodesResponse,
  GetLaundrySlotsQueryParams,
  GetLaundrySlotsResponse,
  UpdateLaundryMeBody,
  UpdateLaundryMeResponse,
  VerifyLaundryQrBody,
  VerifyLaundryQrResponse,
} from "@workspace/api-zod";
import {
  db,
  laundryBookingsTable,
  laundryDutyAssignmentsTable,
  laundryDutyShiftsTable,
  laundryHandoversTable,
  laundryMachinesTable,
  laundryQrTokensTable,
  laundryStudentsTable,
} from "@workspace/db";
import { getClerkUserId, requireAuth } from "../middlewares/auth";
import {
  addDays,
  assignUpcomingDuty,
  dateStringFromQuery,
  ensureMachines,
  ensureStudentForRequest,
  ensureWeekendSchedule,
  getBookingViews,
  getDutyViews,
  getProfileView,
  getSaturdayForDate,
  indiaDate,
  indiaDateTime,
  statusForTime,
} from "../lib/laundry";

const router: IRouter = Router();
router.use("/laundry", requireAuth);

function endOfSlot(startAt: Date): Date {
  return new Date(startAt.getTime() + 30 * 60 * 1000);
}

function localTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { hour: get("hour"), minute: get("minute"), second: get("second") };
}

function invalidQr(message: string) {
  return VerifyLaundryQrResponse.parse({
    valid: false,
    message,
    kind: "booking",
    relatedId: null,
  });
}

async function createOrGetQrToken(
  studentId: number,
  kind: "booking" | "duty",
  referenceId: number,
  endAt: Date,
) {
  const [existing] = await db
    .select()
    .from(laundryQrTokensTable)
    .where(
      and(
        eq(laundryQrTokensTable.studentId, studentId),
        eq(laundryQrTokensTable.kind, kind),
        eq(laundryQrTokensTable.referenceId, referenceId),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const token = randomBytes(24).toString("base64url");
  const [created] = await db
    .insert(laundryQrTokensTable)
    .values({
      studentId,
      kind,
      referenceId,
      token,
      expiresAt: new Date(endAt.getTime() + 15 * 60 * 1000),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [concurrent] = await db
    .select()
    .from(laundryQrTokensTable)
    .where(
      and(
        eq(laundryQrTokensTable.studentId, studentId),
        eq(laundryQrTokensTable.kind, kind),
        eq(laundryQrTokensTable.referenceId, referenceId),
      ),
    )
    .limit(1);
  if (!concurrent) throw new Error("Could not create QR credential.");
  return concurrent;
}

router.get("/laundry/me", async (req, res): Promise<void> => {
  const student = await ensureStudentForRequest(req);
  const profile = await getProfileView(student);
  res.json(GetLaundryMeResponse.parse(profile));
});

router.patch("/laundry/me", async (req, res): Promise<void> => {
  const body = UpdateLaundryMeBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const student = await ensureStudentForRequest(req);
  const [updated] = await db
    .update(laundryStudentsTable)
    .set({ name: body.data.name.trim(), room: body.data.room.trim() })
    .where(eq(laundryStudentsTable.id, student.id))
    .returning();
  const profile = await getProfileView(updated);
  res.json(UpdateLaundryMeResponse.parse(profile));
});

router.get("/laundry/dashboard", async (req, res): Promise<void> => {
  const student = await ensureStudentForRequest(req);
  await ensureMachines();
  await assignUpcomingDuty(student.id);

  const [bookings, duties] = await Promise.all([
    getBookingViews(student.id),
    getDutyViews(student.id),
  ]);
  const profile = await getProfileView(student);
  const saturday = getUpcomingSaturdayFromDate();
  const weekendStart = indiaDateTime(saturday, 8 * 60);
  const weekendEnd = indiaDateTime(addDays(saturday, 2), 2 * 60);
  const dashboard = {
    student: profile,
    nextBooking:
      bookings.find(
        (booking) =>
          booking.status === "upcoming" || booking.status === "active",
      ) ?? null,
    nextDuty:
      duties.find(
        (duty) => duty.status === "upcoming" || duty.status === "active",
      ) ?? null,
    weekendBookings: bookings.filter(
      (booking) =>
        booking.startAt >= weekendStart && booking.startAt < weekendEnd,
    ).length,
    weekendDuties: duties.filter(
      (duty) => duty.startAt >= weekendStart && duty.startAt < weekendEnd,
    ).length,
  };
  res.json(GetLaundryDashboardResponse.parse(dashboard));
});

router.get("/laundry/slots", async (req, res): Promise<void> => {
  const dateString = dateStringFromQuery(req.query.date);
  const parsed = dateString
    ? GetLaundrySlotsQueryParams.safeParse({
        date: new Date(`${dateString}T12:00:00.000Z`),
      })
    : null;
  if (!parsed?.success || !dateString) {
    res.status(400).json({ error: "Choose a valid Saturday or Sunday." });
    return;
  }

  const saturday = getSaturdayForDate(dateString);
  if (!saturday) {
    res.status(400).json({ error: "Laundry slots are available on weekends." });
    return;
  }
  await ensureWeekendSchedule(saturday);
  const student = await ensureStudentForRequest(req);
  const machines = await ensureMachines();
  const firstSlot = indiaDateTime(dateString, 8 * 60);
  const finalSlot = indiaDateTime(dateString, 26 * 60);
  const now = new Date();
  const [bookings, duties] = await Promise.all([
    db
      .select({
        machineId: laundryBookingsTable.machineId,
        startAt: laundryBookingsTable.startAt,
        endAt: laundryBookingsTable.endAt,
      })
      .from(laundryBookingsTable)
      .where(
        and(
          gte(laundryBookingsTable.startAt, firstSlot),
          lt(laundryBookingsTable.startAt, finalSlot),
          sql`${laundryBookingsTable.status} <> 'cancelled'`,
        ),
      ),
    db
      .select({
        startAt: laundryDutyShiftsTable.startAt,
        endAt: laundryDutyShiftsTable.endAt,
      })
      .from(laundryDutyAssignmentsTable)
      .innerJoin(
        laundryDutyShiftsTable,
        eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
      )
      .where(
        and(
          eq(laundryDutyAssignmentsTable.studentId, student.id),
          gt(laundryDutyShiftsTable.endAt, now),
        ),
      ),
  ]);
  const ownBookings = await db
    .select({
      startAt: laundryBookingsTable.startAt,
      endAt: laundryBookingsTable.endAt,
    })
    .from(laundryBookingsTable)
    .where(
      and(
        eq(laundryBookingsTable.studentId, student.id),
        gt(laundryBookingsTable.endAt, now),
        sql`${laundryBookingsTable.status} <> 'cancelled'`,
      ),
    );

  const slots = Array.from({ length: 36 }, (_, index) => {
    const startAt = indiaDateTime(dateString, 8 * 60 + index * 30);
    const endAt = endOfSlot(startAt);
    return machines.map((machine) => ({
      startAt,
      endAt,
      machineId: machine.id,
      machineName: machine.name,
      available:
        startAt > now &&
        !bookings.some(
          (booking) =>
            booking.machineId === machine.id &&
            booking.startAt < endAt &&
            booking.endAt > startAt,
        ) &&
        !ownBookings.some(
          (booking) => booking.startAt < endAt && booking.endAt > startAt,
        ) &&
        !duties.some(
          (duty) => duty.startAt < endAt && duty.endAt > startAt,
        ),
    }));
  }).flat();
  res.json(GetLaundrySlotsResponse.parse(slots));
});

router.get("/laundry/bookings", async (req, res): Promise<void> => {
  const student = await ensureStudentForRequest(req);
  const bookings = await getBookingViews(student.id);
  res.json(GetLaundryBookingsResponse.parse(bookings));
});

router.post("/laundry/bookings", async (req, res): Promise<void> => {
  const parsed = CreateLaundryBookingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const student = await ensureStudentForRequest(req);
  const startAt = parsed.data.startAt;
  const endAt = endOfSlot(startAt);
  const time = localTime(startAt);
  const day = indiaDate(startAt);
  const dayOfWeek = new Date(`${day}T12:00:00.000Z`).getUTCDay();
  const saturday =
    time.hour >= 8
      ? dayOfWeek === 6
        ? day
        : dayOfWeek === 0
          ? addDays(day, -1)
          : null
      : time.hour < 2
        ? dayOfWeek === 0
          ? addDays(day, -1)
          : dayOfWeek === 1
            ? addDays(day, -2)
            : null
        : null;
  if (
    !saturday ||
    startAt <= new Date() ||
    !(time.hour < 2 || time.hour >= 8) ||
    time.minute % 30 !== 0 ||
    time.second !== 0
  ) {
    res.status(400).json({
      error: "Choose a future half-hour slot between 8:00 AM and 2:00 AM.",
    });
    return;
  }

  await ensureWeekendSchedule(saturday);
  const machines = await ensureMachines();
  const machine = machines.find((item) => item.id === parsed.data.machineId);
  if (!machine) {
    res.status(404).json({ error: "That laundry machine is not available." });
    return;
  }

  await assignUpcomingDuty(student.id);
  const [assignedDuty] = await db
    .select({ id: laundryDutyAssignmentsTable.id })
    .from(laundryDutyAssignmentsTable)
    .innerJoin(
      laundryDutyShiftsTable,
      eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
    )
    .where(
      and(
        eq(laundryDutyAssignmentsTable.studentId, student.id),
        gt(laundryDutyShiftsTable.endAt, new Date()),
      ),
    )
    .limit(1);
  if (!assignedDuty) {
    res.status(409).json({
      error:
        "A supervision duty is required before booking. No eligible duty shift is currently available.",
    });
    return;
  }

  const [overlappingDuty] = await db
    .select({ id: laundryDutyAssignmentsTable.id })
    .from(laundryDutyAssignmentsTable)
    .innerJoin(
      laundryDutyShiftsTable,
      eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
    )
    .where(
      and(
        eq(laundryDutyAssignmentsTable.studentId, student.id),
        lt(laundryDutyShiftsTable.startAt, endAt),
        gt(laundryDutyShiftsTable.endAt, startAt),
      ),
    )
    .limit(1);
  if (overlappingDuty) {
    res.status(409).json({
      error: "Your laundry booking cannot overlap with your supervision duty.",
    });
    return;
  }

  const [overlappingBooking] = await db
    .select({ id: laundryBookingsTable.id })
    .from(laundryBookingsTable)
    .where(
      and(
        lt(laundryBookingsTable.startAt, endAt),
        gt(laundryBookingsTable.endAt, startAt),
        sql`${laundryBookingsTable.status} <> 'cancelled'`,
        sql`(${laundryBookingsTable.studentId} = ${student.id} OR ${laundryBookingsTable.machineId} = ${machine.id})`,
      ),
    )
    .limit(1);
  if (overlappingBooking) {
    res.status(409).json({ error: "That half-hour slot was just booked." });
    return;
  }

  const [booking] = await db
    .insert(laundryBookingsTable)
    .values({
      studentId: student.id,
      machineId: machine.id,
      startAt,
      endAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!booking) {
    res.status(409).json({ error: "That machine slot is no longer available." });
    return;
  }

  res
    .status(201)
    .json(
      CreateLaundryBookingResponse.parse({
        ...booking,
        machineName: machine.name,
        status: statusForTime(booking.startAt, booking.endAt, false),
      }),
    );
});

router.delete(
  "/laundry/bookings/:bookingId",
  async (req, res): Promise<void> => {
    const student = await ensureStudentForRequest(req);
    const params = CancelLaundryBookingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [booking] = await db
      .select()
      .from(laundryBookingsTable)
      .where(
        and(
          eq(laundryBookingsTable.id, params.data.bookingId),
          eq(laundryBookingsTable.studentId, student.id),
        ),
      )
      .limit(1);
    if (!booking) {
      res.status(404).json({ error: "Booking not found." });
      return;
    }
    if (booking.startAt <= new Date() || booking.status === "cancelled") {
      res.status(409).json({ error: "This booking can no longer be cancelled." });
      return;
    }
    await db
      .update(laundryBookingsTable)
      .set({ status: "cancelled" })
      .where(eq(laundryBookingsTable.id, booking.id));
    res.sendStatus(204);
  },
);

router.get("/laundry/duties", async (req, res): Promise<void> => {
  const student = await ensureStudentForRequest(req);
  await assignUpcomingDuty(student.id);
  const duties = await getDutyViews(student.id);
  res.json(GetLaundryDutiesResponse.parse(duties));
});

router.get("/laundry/qr-codes", async (req, res): Promise<void> => {
  const student = await ensureStudentForRequest(req);
  await assignUpcomingDuty(student.id);
  const [bookings, duties] = await Promise.all([
    db
      .select()
      .from(laundryBookingsTable)
      .where(
        and(
          eq(laundryBookingsTable.studentId, student.id),
          sql`${laundryBookingsTable.status} <> 'cancelled'`,
          gt(laundryBookingsTable.endAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(asc(laundryBookingsTable.startAt)),
    db
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
          eq(laundryDutyAssignmentsTable.studentId, student.id),
          gt(laundryDutyShiftsTable.endAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(asc(laundryDutyShiftsTable.startAt)),
  ]);

  const credentials = await Promise.all([
    ...bookings.map(async (booking) => {
      const credential = await createOrGetQrToken(
        student.id,
        "booking",
        booking.id,
        booking.endAt,
      );
      return {
        id: credential.id,
        kind: "booking" as const,
        token: credential.token,
        label: "Laundry booking",
        startAt: booking.startAt,
        endAt: booking.endAt,
        status: statusForTime(
          booking.startAt,
          booking.endAt,
          booking.endAt <= new Date(),
        ),
      };
    }),
    ...duties.map(async ({ assignment, shift }) => {
      const credential = await createOrGetQrToken(
        student.id,
        "duty",
        assignment.id,
        shift.endAt,
      );
      return {
        id: credential.id,
        kind: "duty" as const,
        token: credential.token,
        label: "Supervision duty",
        startAt: shift.startAt,
        endAt: shift.endAt,
        status: statusForTime(
          shift.startAt,
          shift.endAt,
          shift.endAt <= new Date() && assignment.checkedInAt !== null,
        ),
      };
    }),
  ]);
  credentials.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  res.json(GetLaundryQrCodesResponse.parse(credentials));
});

router.post("/laundry/check-ins", async (req, res): Promise<void> => {
  const parsed = VerifyLaundryQrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const student = await ensureStudentForRequest(req);
  const [credential] = await db
    .select()
    .from(laundryQrTokensTable)
    .where(eq(laundryQrTokensTable.token, parsed.data.token))
    .limit(1);
  if (!credential) {
    res.json(invalidQr("This QR code is not recognized."));
    return;
  }
  if (credential.usedAt) {
    res.json(
      VerifyLaundryQrResponse.parse({
        valid: true,
        message: "This code has already been verified.",
        kind: credential.kind,
        relatedId: credential.referenceId,
      }),
    );
    return;
  }
  const now = new Date();
  if (credential.expiresAt <= now) {
    res.json(invalidQr("This QR code has expired."));
    return;
  }

  if (credential.kind === "booking") {
    const [booking] = await db
      .select()
      .from(laundryBookingsTable)
      .where(eq(laundryBookingsTable.id, credential.referenceId))
      .limit(1);
    if (!booking || booking.status === "cancelled") {
      res.json(invalidQr("This booking is no longer active."));
      return;
    }
    const [onDuty] = await db
      .select({ id: laundryDutyAssignmentsTable.id })
      .from(laundryDutyAssignmentsTable)
      .innerJoin(
        laundryDutyShiftsTable,
        eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
      )
      .where(
        and(
          eq(laundryDutyAssignmentsTable.studentId, student.id),
          lt(laundryDutyShiftsTable.startAt, now),
          gt(laundryDutyShiftsTable.endAt, now),
        ),
      )
      .limit(1);
    if (!onDuty) {
      res.json(invalidQr("Only the on-duty supervisor can verify a booking."));
      return;
    }
    if (
      booking.startAt.getTime() - 15 * 60 * 1000 > now.getTime() ||
      booking.endAt.getTime() + 15 * 60 * 1000 < now.getTime()
    ) {
      res.json(invalidQr("This booking is outside its check-in window."));
      return;
    }
    await db
      .update(laundryBookingsTable)
      .set({ checkedInAt: now })
      .where(eq(laundryBookingsTable.id, booking.id));
  } else if (credential.kind === "duty") {
    const [assignment] = await db
      .select({
        assignment: laundryDutyAssignmentsTable,
        shift: laundryDutyShiftsTable,
      })
      .from(laundryDutyAssignmentsTable)
      .innerJoin(
        laundryDutyShiftsTable,
        eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
      )
      .where(eq(laundryDutyAssignmentsTable.id, credential.referenceId))
      .limit(1);
    if (!assignment) {
      res.json(invalidQr("This duty assignment no longer exists."));
      return;
    }
    const myDuties = await db
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
          eq(laundryDutyAssignmentsTable.studentId, student.id),
          gt(
            laundryDutyShiftsTable.endAt,
            new Date(now.getTime() - 24 * 60 * 60 * 1000),
          ),
        ),
      );
    const sameShiftPartner = myDuties.find(
      (duty) =>
        duty.shift.id === assignment.shift.id &&
        duty.assignment.id !== assignment.assignment.id,
    );
    let handoverPartner = false;
    if (!sameShiftPartner) {
      for (const duty of myDuties) {
        const [pair] = await db
          .select({ id: laundryHandoversTable.id })
          .from(laundryHandoversTable)
          .where(
            or(
              and(
                eq(laundryHandoversTable.fromShiftId, duty.shift.id),
                eq(laundryHandoversTable.toShiftId, assignment.shift.id),
              ),
              and(
                eq(laundryHandoversTable.fromShiftId, assignment.shift.id),
                eq(laundryHandoversTable.toShiftId, duty.shift.id),
              ),
            ),
          )
          .limit(1);
        if (pair) {
          handoverPartner = true;
          break;
        }
      }
    }
    if (!sameShiftPartner && !handoverPartner) {
      res.json(
        invalidQr(
          "Only a co-supervisor or assigned handover partner can verify this duty.",
        ),
      );
      return;
    }
    if (
      assignment.shift.startAt.getTime() - 15 * 60 * 1000 > now.getTime() ||
      assignment.shift.endAt.getTime() + 15 * 60 * 1000 < now.getTime()
    ) {
      res.json(invalidQr("This duty is outside its check-in window."));
      return;
    }
    if (sameShiftPartner) {
      await db
        .update(laundryDutyAssignmentsTable)
        .set({ checkedInAt: now })
        .where(eq(laundryDutyAssignmentsTable.id, assignment.assignment.id));
    }
    const resultMessage = sameShiftPartner
      ? "Duty check-in verified."
      : "Duty code verified for the scheduled handover.";
    await db
      .update(laundryQrTokensTable)
      .set({ usedAt: now })
      .where(eq(laundryQrTokensTable.id, credential.id));
    res.json(
      VerifyLaundryQrResponse.parse({
        valid: true,
        message: resultMessage,
        kind: credential.kind,
        relatedId: credential.referenceId,
      }),
    );
    return;
  } else {
    res.json(invalidQr("This QR code type is not supported."));
    return;
  }

  await db
    .update(laundryQrTokensTable)
    .set({ usedAt: now })
    .where(eq(laundryQrTokensTable.id, credential.id));
  res.json(
    VerifyLaundryQrResponse.parse({
      valid: true,
      message: "Check-in verified.",
      kind: credential.kind,
      relatedId: credential.referenceId,
    }),
  );
});

router.post("/laundry/handovers", async (req, res): Promise<void> => {
  const parsed = CompleteLaundryHandoverBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const student = await ensureStudentForRequest(req);
  const [currentAssignment] = await db
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
        eq(laundryDutyAssignmentsTable.id, parsed.data.dutyId),
        eq(laundryDutyAssignmentsTable.studentId, student.id),
      ),
    )
    .limit(1);
  if (!currentAssignment) {
    res.status(404).json({ error: "Your duty assignment was not found." });
    return;
  }

  const [partnerCredential] = await db
    .select()
    .from(laundryQrTokensTable)
    .where(eq(laundryQrTokensTable.token, parsed.data.partnerToken))
    .limit(1);
  if (
    !partnerCredential ||
    partnerCredential.kind !== "duty" ||
    partnerCredential.expiresAt <= new Date()
  ) {
    res.status(400).json({ error: "Scan a valid supervisor duty code." });
    return;
  }
  const [partnerAssignment] = await db
    .select()
    .from(laundryDutyAssignmentsTable)
    .where(eq(laundryDutyAssignmentsTable.id, partnerCredential.referenceId))
    .limit(1);
  if (
    !partnerAssignment ||
    partnerAssignment.studentId === student.id ||
    partnerAssignment.shiftId === currentAssignment.shift.id
  ) {
    res.status(400).json({
      error: "The code must belong to a supervisor on the adjacent shift.",
    });
    return;
  }

  const currentIsOutgoing =
    currentAssignment.shift.startAt < (await db
      .select({ startAt: laundryDutyShiftsTable.startAt })
      .from(laundryDutyShiftsTable)
      .where(eq(laundryDutyShiftsTable.id, partnerAssignment.shiftId))
      .then(([shift]) => shift?.startAt ?? new Date(0)));
  const fromShiftId = currentIsOutgoing
    ? currentAssignment.shift.id
    : partnerAssignment.shiftId;
  const toShiftId = currentIsOutgoing
    ? partnerAssignment.shiftId
    : currentAssignment.shift.id;
  const [handover] = await db
    .select()
    .from(laundryHandoversTable)
    .where(
      and(
        eq(laundryHandoversTable.fromShiftId, fromShiftId),
        eq(laundryHandoversTable.toShiftId, toShiftId),
      ),
    )
    .limit(1);
  if (!handover) {
    res.status(400).json({ error: "These shifts do not have a scheduled handover." });
    return;
  }

  const update = currentIsOutgoing
    ? { outgoingConfirmed: true }
    : { incomingConfirmed: true };
  const bothConfirmed =
    (currentIsOutgoing || handover.outgoingConfirmed) &&
    (!currentIsOutgoing || handover.incomingConfirmed);
  const [updatedHandover] = await db
    .update(laundryHandoversTable)
    .set({
      ...update,
      completedAt: bothConfirmed ? new Date() : handover.completedAt,
    })
    .where(eq(laundryHandoversTable.id, handover.id))
    .returning();

  const duties = await getDutyViews(student.id);
  const currentDuty = duties.find(
    (duty) => duty.id === currentAssignment.assignment.id,
  );
  res.json(
    CompleteLaundryHandoverResponse.parse(
      currentDuty ?? {
        id: currentAssignment.assignment.id,
        startAt: currentAssignment.shift.startAt,
        endAt: currentAssignment.shift.endAt,
        status: "upcoming",
        partnerName: "Supervisor",
        room: "Laundry room",
        incomingConfirmed: updatedHandover.incomingConfirmed,
        outgoingConfirmed: updatedHandover.outgoingConfirmed,
      },
    ),
  );
});

function getUpcomingSaturdayFromDate(): string {
  const today = indiaDate();
  const day = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  return addDays(today, (6 - day + 7) % 7);
}

export default router;
