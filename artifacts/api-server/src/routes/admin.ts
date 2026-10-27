import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  laundryBookingsTable,
  laundryDutyAssignmentsTable,
  laundryDutyShiftsTable,
  laundryHandoversTable,
  laundryMachinesTable,
  laundryStudentsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import {
  ensureStudentForRequest,
  getUpcomingSaturday,
  addDays,
  ensureWeekendSchedule,
} from "../lib/laundry";
import { getAuth } from "@clerk/express";
import type { Request, Response } from "express";

const router: IRouter = Router();
router.use("/admin", requireAuth);

async function requireAdmin(req: Request, res: Response): Promise<boolean> {
  const auth = getAuth(req);
  const claims = auth.sessionClaims as Record<string, unknown> | undefined;
  const metadata = (claims?.publicMetadata ?? claims?.public_metadata ?? claims?.metadata) as Record<string, unknown> | undefined;
  if (metadata?.role === "admin") return true;

  // Fallback: check if the user is the admin user ID or check Clerk API directly
  if (auth.userId) {
    try {
      const uRes = await fetch(`https://api.clerk.com/v1/users/${auth.userId}`, {
        headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` }
      });
      if (uRes.ok) {
        const u = (await uRes.json()) as any;
        if (u?.username === "admin" || u?.public_metadata?.role === "admin") {
          return true;
        }
      }
    } catch (e) {
      console.error("Error verifying admin user with Clerk API:", e);
    }
  }

  res.status(403).json({ error: "Admin access required." });
  return false;
}

// Overview stats
router.get("/admin/overview", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const now = new Date();
  const [ts] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryStudentsTable);
  const [tb] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryBookingsTable);
  const [ab] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryBookingsTable)
    .where(and(lt(laundryBookingsTable.startAt, now), gte(laundryBookingsTable.endAt, now)));
  const [cb] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryBookingsTable)
    .where(eq(laundryBookingsTable.status, "completed"));
  const [tm] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryMachinesTable);
  const [ph] = await db.select({ count: sql<number>`count(*)::int` }).from(laundryHandoversTable)
    .where(sql`not ${laundryHandoversTable.incomingConfirmed} or not ${laundryHandoversTable.outgoingConfirmed}`);
  res.json({ totalStudents: ts?.count ?? 0, totalBookings: tb?.count ?? 0, activeBookings: ab?.count ?? 0, completedBookings: cb?.count ?? 0, totalMachines: tm?.count ?? 0, pendingHandovers: ph?.count ?? 0 });
});

// All students
router.get("/admin/students", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const students = await db.select().from(laundryStudentsTable).orderBy(asc(laundryStudentsTable.name));
  res.json(students);
});

// Update student
router.put("/admin/students/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id." }); return; }
  const { name, room, role, rollNumber, email } = req.body;
  const updates: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof room === "string" && room.trim()) updates.room = room.trim();
  if (role === "student" || role === "manager") updates.role = role;
  if (typeof rollNumber === "string") updates.rollNumber = rollNumber.trim() || null;
  if (typeof email === "string") updates.email = email.trim() || null;
  if (!Object.keys(updates).length) { res.status(400).json({ error: "No valid fields." }); return; }
  const [updated] = await db.update(laundryStudentsTable).set(updates).where(eq(laundryStudentsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Student not found." }); return; }
  res.json(updated);
});

// Delete student
router.delete("/admin/students/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id." }); return; }
  await db.delete(laundryBookingsTable).where(eq(laundryBookingsTable.studentId, id));
  await db.delete(laundryDutyAssignmentsTable).where(eq(laundryDutyAssignmentsTable.studentId, id));
  const [deleted] = await db.delete(laundryStudentsTable).where(eq(laundryStudentsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Student not found." }); return; }
  res.json({ success: true });
});

// All bookings
router.get("/admin/bookings", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const rows = await db.select({
    booking: laundryBookingsTable,
    studentName: laundryStudentsTable.name,
    studentRoom: laundryStudentsTable.room,
    machineName: laundryMachinesTable.name,
  }).from(laundryBookingsTable)
    .innerJoin(laundryStudentsTable, eq(laundryBookingsTable.studentId, laundryStudentsTable.id))
    .innerJoin(laundryMachinesTable, eq(laundryBookingsTable.machineId, laundryMachinesTable.id))
    .orderBy(desc(laundryBookingsTable.startAt));
  res.json(rows.map(r => ({ id: r.booking.id, studentName: r.studentName, studentRoom: r.studentRoom, machineName: r.machineName, startAt: r.booking.startAt, endAt: r.booking.endAt, status: r.booking.status })));
});

// Cancel / status patch booking
router.patch("/admin/bookings/:id/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  const { status } = req.body;
  if (!["upcoming", "completed", "cancelled"].includes(status)) { res.status(400).json({ error: "Invalid status." }); return; }
  const [updated] = await db.update(laundryBookingsTable).set({ status }).where(eq(laundryBookingsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Booking not found." }); return; }
  res.json(updated);
});

// Delete booking
router.delete("/admin/bookings/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id." }); return; }
  const [deleted] = await db.delete(laundryBookingsTable).where(eq(laundryBookingsTable.id, id)).returning();
  if (!deleted) { res.status(404).json({ error: "Booking not found." }); return; }
  res.json({ success: true });
});

// All machines
router.get("/admin/machines", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const machines = await db.select().from(laundryMachinesTable).orderBy(asc(laundryMachinesTable.id));
  res.json(machines);
});

// Add machine
router.post("/admin/machines", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const { name } = req.body;
  if (typeof name !== "string" || !name.trim()) { res.status(400).json({ error: "Name is required." }); return; }
  const [created] = await db.insert(laundryMachinesTable).values({ name: name.trim() }).returning();
  res.json(created);
});

// Update machine
router.put("/admin/machines/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id." }); return; }
  const { name, isActive } = req.body;
  const updates: Record<string, unknown> = {};
  if (typeof name === "string" && name.trim()) updates.name = name.trim();
  if (typeof isActive === "boolean") updates.isActive = isActive;
  const [updated] = await db.update(laundryMachinesTable).set(updates).where(eq(laundryMachinesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Machine not found." }); return; }
  res.json(updated);
});

// Duty roster
router.get("/admin/duties", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const now = new Date();
  const rows = await db.select({
    assignment: laundryDutyAssignmentsTable,
    shift: laundryDutyShiftsTable,
    studentName: laundryStudentsTable.name,
    studentRoom: laundryStudentsTable.room,
  }).from(laundryDutyAssignmentsTable)
    .innerJoin(laundryDutyShiftsTable, eq(laundryDutyAssignmentsTable.shiftId, laundryDutyShiftsTable.id))
    .innerJoin(laundryStudentsTable, eq(laundryDutyAssignmentsTable.studentId, laundryStudentsTable.id))
    .where(gte(laundryDutyShiftsTable.startAt, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)))
    .orderBy(asc(laundryDutyShiftsTable.startAt));
  res.json(rows.map(r => ({ id: r.assignment.id, studentName: r.studentName, studentRoom: r.studentRoom, startAt: r.shift.startAt, endAt: r.shift.endAt, checkedInAt: r.assignment.checkedInAt })));
});

// Generate schedule
router.post("/admin/schedule", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const saturday = getUpcomingSaturday();
  await ensureWeekendSchedule(saturday);
  await ensureWeekendSchedule(addDays(saturday, 7));
  res.json({ success: true, saturday });
});

export default router;
