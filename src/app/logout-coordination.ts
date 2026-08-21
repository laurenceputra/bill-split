type Quiesce = () => Promise<void>;
type Resume = () => void;

let quiesce: Quiesce = async () => undefined;
let resume: Resume = () => undefined;

/** The API owns logout ordering; the outbox registers its local in-flight work here. */
export const registerLogoutCoordinator = (nextQuiesce: Quiesce, nextResume: Resume) => {
  quiesce = nextQuiesce;
  resume = nextResume;
};

export const quiesceOutboxForLogout = () => quiesce();
export const resumeOutboxAfterFailedLogout = () => resume();
