import { Router, type IRouter } from "express";
import healthRouter from "./health";
import laundryRouter from "./laundry";
import managementRouter from "./management";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(laundryRouter);
router.use(managementRouter);
router.use(adminRouter);

export default router;
