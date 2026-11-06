// The payment-history CSV an admin downloads to fill in.
export const LEGACY_CSV_TEMPLATE_NAME = "payment-history-template.csv";

const ADDR1 = "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae";
const ADDR2 = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";

export const LEGACY_CSV_TEMPLATE = [
  "userId,ADA,AGIX,task,date,workgroup,txHash,outputIndex",
  `${ADDR1},,480,"Meeting documentation: 25th, 27th Aug",15.09.2026,governance-workgroup,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,0`,
  `${ADDR2},114.5,,Contribution handling fee,15.09.26,treasury-guild,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,0`,
  "",
].join("\r\n");
