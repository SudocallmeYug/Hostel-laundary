import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetManagementOverviewResponse } from "@workspace/api-zod";
import {
  db,
  laundryBookingsTable,
  laundryDutyAssignmentsTable,
  laundryDutyShiftsTable,
  laundryHandoversTable,
  laundryStudentsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import {
  addDays,
  ensureStudentForRequest,
  ensureWeekendSchedule,
  getUpcomingSaturday,
  indiaDateTime,
} from "../lib/laundry";

const router: IRouter = Router();
router.use("/management", requireAuth);

router.get("/management/overview", async (req, res): Promise<void> => {
  const manager = await ensureStudentForRequest(req);
  if (manager.role !== "manager") {
    res.status(403).json({ error: "Manager access is required." });
    return;
  }

  const saturday = getUpcomingSaturday();
  await ensureWeekendSchedule(saturday);
  const now = new Date();
  const [studentCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(laundryStudentsTable);
  const [activeBookingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(laundryBookingsTable)
    .where(
      and(
        lt(laundryBookingsTable.startAt, now),
        gte(laundryBookingsTable.endAt, now),
        eq(laundryBookingsTable.status, "upcoming"),
      ),
    );

  const shifts = await db
    .select({
      shiftId: laundryDutyShiftsTable.id,
      startAt: laundryDutyShiftsTable.startAt,
      assigned: sql<number>`count(${laundryDutyAssignmentsTable.id})::int`,
    })
    .from(laundryDutyShiftsTable)
    .leftJoin(
      laundryDutyAssignmentsTable,
      eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
    )
    .where(
      and(
        gte(laundryDutyShiftsTable.startAt, indiaDateTime(saturday, 8 * 60)),
        lt(
          laundryDutyShiftsTable.startAt,
          indiaDateTime(addDays(saturday, 2), 2 * 60),
        ),
      ),
    )
    .groupBy(laundryDutyShiftsTable.id, laundryDutyShiftsTable.startAt)
    .orderBy(asc(laundryDutyShiftsTable.startAt));

  const [handoverCounts, assignmentsToReview] = await Promise.all([
    db.select().from(laundryHandoversTable),
    db
      .select({
        shiftId: laundryDutyShiftsTable.id,
        checkedInAt: laundryDutyAssignmentsTable.checkedInAt,
      })
      .from(laundryDutyAssignmentsTable)
      .innerJoin(
        laundryDutyShiftsTable,
        eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id),
      )
      .where(
        and(
          lt(laundryDutyShiftsTable.endAt, now),
          gte(
            laundryDutyShiftsTable.startAt,
            new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          ),
        ),
      ),
  ]);

  const completedDuties = assignmentsToReview.filter((assignment) => {
    if (!assignment.checkedInAt) return false;
    const incoming = handoverCounts.find(
      (handover) => handover.toShiftId === assignment.shiftId,
    );
    const outgoing = handoverCounts.find(
      (handover) => handover.fromShiftId === assignment.shiftId,
    );
    return (
      (incoming?.incomingConfirmed ?? true) &&
      (outgoing?.outgoingConfirmed ?? true)
    );
  }).length;
  const pendingHandovers = handoverCounts.filter(
    (handover) => !handover.incomingConfirmed || !handover.outgoingConfirmed,
  ).length;

  const result = {
    students: studentCount?.count ?? 0,
    activeBookings: activeBookingCount?.count ?? 0,
    completedDuties,
    pendingHandovers,
    weekendCoverage: shifts.map(({ startAt, assigned }) => ({
      startAt,
      assigned,
      required: 2,
    })),
  };
  res.json(GetManagementOverviewResponse.parse(result));
});

export default router;
