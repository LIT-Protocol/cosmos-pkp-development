import { encodeSecp256k1Pubkey, makeSignDoc as makeSignDocAmino, StdFee } from "@cosmjs/amino";
import { fromBase64, fromHex, toBase64 } from "@cosmjs/encoding";
import { Int53, Uint53 } from "@cosmjs/math";
import {
  EncodeObject,
  encodePubkey,
  GeneratedType,
  isOfflineDirectSigner,
  makeAuthInfoBytes,
  makeSignDoc,
  OfflineSigner,
  Registry,
  TxBodyEncodeObject,
  // @ts-ignore
} from "./proto-signing/src";
import { HttpEndpoint, Tendermint34Client } from "@cosmjs/tendermint-rpc";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
// @ts-ignore
import Long from "long";
import { AminoConverters, AminoTypes } from "./stargate/src/aminotypes";
import { calculateFee, GasPrice } from "./stargate/src/fee";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import {
  authzTypes,
  bankTypes,
  distributionTypes,
  feegrantTypes,
  govTypes,
  ibcTypes,
  MsgDelegateEncodeObject,
  MsgSendEncodeObject,
  MsgTransferEncodeObject,
  MsgUndelegateEncodeObject,
  MsgWithdrawDelegatorRewardEncodeObject,
  stakingTypes,
  vestingTypes,
} from "./stargate/src/modules";
import {
  createAuthzAminoConverters,
  createBankAminoConverters,
  createDistributionAminoConverters,
  createFeegrantAminoConverters,
  createGovAminoConverters,
  createIbcAminoConverters,
  createStakingAminoConverters,
  createVestingAminoConverters,
} from "./stargate/src/modules";
import { DeliverTxResponse, StargateClient, StargateClientOptions } from "./stargate/src/stargateclient";
import {
  compressPublicKey, hexSigToBase64Sig,
  hexToBase64, makeLogReadableInTerminal,
  pkpPubKeyToCosmosAddress
} from "./helpers/litHelpers";
import { signCosmosTxWithLit } from "./signWithLit";
import { ethers } from "ethers";
import { sha256 } from "@cosmjs/crypto";
import { stubSignDoc } from "./stub/stubSignDoc";
import { stubAuthInfoBytes, stubTxBodyBytes } from "./stub/stubSignDocVars";
import { assertDefined } from "@cosmjs/utils";

export const defaultRegistryTypes: ReadonlyArray<[string, GeneratedType]> = [
  ["/cosmos.base.v1beta1.Coin", Coin],
  ...authzTypes,
  ...bankTypes,
  ...distributionTypes,
  ...feegrantTypes,
  ...govTypes,
  ...stakingTypes,
  ...ibcTypes,
  ...vestingTypes,
];

function createDefaultRegistry(): Registry {
  return new Registry(defaultRegistryTypes);
}

/**
 * Signing information for a single signer that is not included in the transaction.
 *
 * @see https://github.com/cosmos/cosmos-sdk/blob/v0.42.2/x/auth/signing/sign_mode_handler.go#L23-L37
 */
export interface SignerData {
  readonly accountNumber: number;
  readonly sequence: number;
  readonly chainId: string;
}

export interface SigningStargateClientOptions extends StargateClientOptions {
  readonly registry?: Registry;
  readonly aminoTypes?: AminoTypes;
  readonly broadcastTimeoutMs?: number;
  readonly broadcastPollIntervalMs?: number;
  readonly gasPrice?: GasPrice;
}

export interface AuthSig {
  sig: string;
  derivedVia: string;
  signedMessage: string;
  address: string;
}

function createDefaultTypes(): AminoConverters {
  return {
    ...createAuthzAminoConverters(),
    ...createBankAminoConverters(),
    ...createDistributionAminoConverters(),
    ...createGovAminoConverters(),
    ...createStakingAminoConverters(),
    ...createIbcAminoConverters(),
    ...createFeegrantAminoConverters(),
    ...createVestingAminoConverters(),
  };
}

export class SigningStargateClientWithLit extends StargateClient {
  public readonly registry: Registry;
  public readonly broadcastTimeoutMs: number | undefined;
  public readonly broadcastPollIntervalMs: number | undefined;

  private readonly pkpPublicKey: string;
  private readonly compressedPublicKey: string;
  private readonly authSig: AuthSig;
  private readonly aminoTypes: AminoTypes;
  private readonly gasPrice: GasPrice | undefined;

  public static async createClient(
    pkpPublicKey: string,
    authSig: AuthSig,
    endpoint: string | HttpEndpoint,
    // signer: OfflineSigner,
    options: SigningStargateClientOptions = {},
  ): Promise<SigningStargateClientWithLit> {
    const tmClient = await Tendermint34Client.connect(endpoint);
    return new SigningStargateClientWithLit(pkpPublicKey, authSig, tmClient, options);
  }

  protected constructor(
      pkpPublicKey: string,
      authSig: AuthSig,
      tmClient: Tendermint34Client | undefined,
      options: SigningStargateClientOptions,

  ) {
    super(tmClient, options);
    const { registry = createDefaultRegistry(), aminoTypes = new AminoTypes(createDefaultTypes()) } = options;
    this.registry = registry;
    this.aminoTypes = aminoTypes;
    this.pkpPublicKey = pkpPublicKey;
    this.authSig = authSig;
    this.compressedPublicKey = compressPublicKey(pkpPublicKey);
    this.broadcastTimeoutMs = options.broadcastTimeoutMs;
    this.broadcastPollIntervalMs = options.broadcastPollIntervalMs;
    this.gasPrice = options.gasPrice;
  }

  public async sendTokens(
    recipientAddress: string,
    amount: readonly Coin[],
    fee: StdFee,
    memo = "",
    // ): Promise<DeliverTxResponse> {
  ): Promise<void> {
    const senderAddress = pkpPubKeyToCosmosAddress(this.pkpPublicKey);
    // creates message for transaction
    const sendMsg: MsgSendEncodeObject = {
      typeUrl: "/cosmos.bank.v1beta1.MsgSend",
      value: {
        fromAddress: senderAddress,
        toAddress: recipientAddress,
        amount: [...amount],
      },
    };
    console.log("sendMsg: ", sendMsg)
    return this.signAndBroadcast(senderAddress, [sendMsg], fee, memo);
  }

  public async signAndBroadcast(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee | any,
    memo = "",
    // ): Promise<DeliverTxResponse> {
  ): Promise<any> {
    let usedFee: StdFee = fee
    const txRaw = await this.sign(signerAddress, messages, usedFee, memo);
    if (!!txRaw) {
      const txBytes = TxRaw.encode(txRaw).finish();
      return this.broadcastTx(txBytes);
      // return this.broadcastTx(txBytes, this.broadcastTimeoutMs, this.broadcastPollIntervalMs);
    }
  }

  /**
   * Gets account number and sequence from the API, creates a sign doc,
   * creates a single signature and assembles the signed transaction.
   *
   * The sign mode (SIGN_MODE_DIRECT or SIGN_MODE_LEGACY_AMINO_JSON) is determined by this client's signer.
   *
   * You can pass signer data (account number, sequence and chain ID) explicitly instead of querying them
   * from the chain. This is needed when signing for a multisig account, but it also allows for offline signing
   * (See the SigningStargateClient.offline constructor).
   */
  public async sign(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee,
    memo: string,
    explicitSignerData?: SignerData,
  // ): Promise<TxRaw> {
  ): Promise<any> {
    let signerData: SignerData;
    if (explicitSignerData) {
      signerData = explicitSignerData;
    } else {
      const { accountNumber, sequence } = await this.getSequence(signerAddress);
      console.log('sign: accountNumber', accountNumber)
      console.log('sign: sequence', sequence)
      const chainId = await this.getChainId();
      signerData = {
        accountNumber: accountNumber,
        sequence: sequence,
        chainId: chainId,
      };
    }
    console.log('sign: signerData', signerData);

    return this.signWithLit(signerAddress, messages, fee, memo, signerData)
    // await this.signWithLit(signerAddress, messages, fee, memo, signerData)
  }

  private async signWithLit(
    signerAddress: string,
    messages: readonly EncodeObject[],
    fee: StdFee,
    memo: string,
    { accountNumber, sequence, chainId }: SignerData,
  // ): Promise<TxRaw> {
  ): Promise<any> {
    console.log('signWithLit: fee', fee);

    const uint8PubKey = fromHex(this.compressedPublicKey);

    const txBodyEncodeObject: TxBodyEncodeObject = {
      typeUrl: "/cosmos.tx.v1beta1.TxBody",
      value: {
        messages: messages,
        memo: memo,
      },
    };
    console.log('signWithLit: txBodyEncodeObject', txBodyEncodeObject);

    const txBodyBytes = this.registry.encode(txBodyEncodeObject);;
    console.log('signWithLit: txBodyBytes', txBodyBytes);

    const encodedPubKey = encodePubkey(encodeSecp256k1Pubkey(uint8PubKey));
    console.log('signWithLit: encodedPubKey', encodedPubKey);

    const gasLimit = Int53.fromString(fee.gas).toNumber();
    console.log('signWithLit: gasLimit', gasLimit);

    const authInfoBytes = makeAuthInfoBytes(
      [{ pubkey: encodedPubKey, sequence }],
      fee.amount,
      gasLimit,
      fee.granter,
      fee.payer,
    );
    console.log('signWithLit: authInfoBytes', authInfoBytes);

    const signDocOriginal = makeSignDoc(txBodyBytes, authInfoBytes, chainId, accountNumber);
    console.log('signWithLit: signDoc', signDocOriginal);

    const signDoc = makeSignDoc(stubTxBodyBytes(), stubAuthInfoBytes(), 'theta-testnet-001', 724162);
    console.log('signWithLit: signDoc', signDoc);

    const signerObj = {
      pkpPublicKey: this.pkpPublicKey,
      message: signDoc,
      authSig: this.authSig
    };
    console.log('signWithLit: signerObj', signerObj);

    const signature = await signCosmosTxWithLit(signerObj);
    console.log('signWithLit: signature', signature);

    // const base64Sig = hexSigToBase64Sig(signature.slice(2));
    // const fromBase64Sig = fromBase64(base64Sig)
    //
    // const txRawObj = {
    //   bodyBytes: signDoc.bodyBytes,
    //   authInfoBytes: signDoc.authInfoBytes,
    //   signatures: [fromBase64Sig],
    // }
    // const txRawFromPartial = TxRaw.fromPartial(txRawObj);
    // return txRawFromPartial
  }
}
