// The payment-history CSV an admin downloads to fill in.
export const LEGACY_CSV_TEMPLATE_NAME = "payment-history-template.csv";

export const LEGACY_CSV_TEMPLATE = [
  "userId,ADA,AGIX,task,date,workgroup",
  'f39ntm,,480,"Meeting documentation: 25th, 27th Aug",15.09.2026,governance-workgroup',
  "7xcueh,114.5,,Contribution handling fee,15.09.26,treasury-guild",
  "",
].join("\r\n");
