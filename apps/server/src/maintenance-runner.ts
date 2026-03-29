import { maintenanceService } from "./services/maintenance-service.js";

const operationId = process.argv[2];

if (!operationId) {
  console.error("Maintenance operation id is required.");
  process.exit(1);
}

void maintenanceService
  .runDetached(operationId)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
