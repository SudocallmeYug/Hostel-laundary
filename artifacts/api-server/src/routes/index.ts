import { Router, type IRouter } from "express";
import healthRouter from "./health";
import laundryRouter from "./laundry";
import managementRouter from "./management";

const router: IRouter = Router();

router.use(healthRouter);
router.use(laundryRouter);
router.use(managementRouter);

export default router;
