import { createRoot } from "react-dom/client";
import "../../src/styles/global.css";
import { LockedPage } from "../../src/app/routes/LockedPage";

createRoot(document.getElementById("root")!).render(<LockedPage />);
