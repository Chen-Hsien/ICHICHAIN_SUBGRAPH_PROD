import {
  RevealDrawFulfilled as RevealDrawFulfilledEvent,
  RevealDrawSent as RevealDrawSentEvent,
  ICHICHAIN,
  ICHICHAIN__getSubPrizesDetailResultValue0Struct,
} from "../generated/ICHICHAIN/ICHICHAIN";

import {
  RevealDrawFulfilled,
  RevealDrawSent,
  RevealVRFPrizeDistribution,
  RevealVRFRequest,
  RevealVRFTokenResult,
} from "../generated/schema";

import { BigInt, Bytes } from "@graphprotocol/graph-ts";

const ZERO_BI = BigInt.fromI32(0);
const ONE_BI = BigInt.fromI32(1);

function getRevealRequestEntityId(requestId: BigInt): Bytes {
  return Bytes.fromUTF8(requestId.toString());
}

function getTokenResultEntityId(requestId: BigInt, tokenID: BigInt): Bytes {
  return Bytes.fromUTF8(
    requestId.toString().concat("-").concat(tokenID.toString())
  );
}

function getPrizeDistributionEntityId(
  requestId: BigInt,
  subPrizeID: BigInt
): Bytes {
  return Bytes.fromUTF8(
    requestId.toString().concat("-sub-").concat(subPrizeID.toString())
  );
}

function findBeforeQuantity(
  subPrizeIDs: BigInt[],
  quantitiesBefore: BigInt[],
  targetSubPrizeID: BigInt,
  fallback: BigInt
): BigInt {
  let maxLength = subPrizeIDs.length;
  if (quantitiesBefore.length < maxLength) {
    maxLength = quantitiesBefore.length;
  }

  for (let i = 0; i < maxLength; i++) {
    if (subPrizeIDs[i].equals(targetSubPrizeID)) {
      return quantitiesBefore[i];
    }
  }
  return fallback;
}

function countTokenResultsForPrize(
  revealedPrizeIDs: BigInt[],
  targetSubPrizeID: BigInt
): BigInt {
  let count = ZERO_BI;
  for (let i = 0; i < revealedPrizeIDs.length; i++) {
    if (revealedPrizeIDs[i].equals(targetSubPrizeID)) {
      count = count.plus(ONE_BI);
    }
  }
  return count;
}

export function handleRevealDrawFulfilled(
  event: RevealDrawFulfilledEvent
): void {
  let fulfilledEventEntity = new RevealDrawFulfilled(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  fulfilledEventEntity.requestId = event.params.requestId;
  fulfilledEventEntity.randomWords = event.params.randomWords;
  fulfilledEventEntity.seriesID = event.params.seriesID;
  fulfilledEventEntity.blockNumber = event.block.number;
  fulfilledEventEntity.blockTimestamp = event.block.timestamp;
  fulfilledEventEntity.transactionHash = event.transaction.hash;

  fulfilledEventEntity.save();

  let contract = ICHICHAIN.bind(event.address);
  let subPrizesDetail = new Array<ICHICHAIN__getSubPrizesDetailResultValue0Struct>();
  let subPrizesRemainingQuantitiesAfter = new Array<BigInt>();
  let subPrizeIDsAfter = new Array<BigInt>();
  let subPrizesDetailResult = contract.try_getSubPrizesDetail(
    event.params.seriesID
  );
  if (!subPrizesDetailResult.reverted) {
    subPrizesDetail = subPrizesDetailResult.value;
    for (let i = 0; i < subPrizesDetail.length; i++) {
      subPrizeIDsAfter.push(subPrizesDetail[i].subPrizeID);
      subPrizesRemainingQuantitiesAfter.push(
        subPrizesDetail[i].subPrizeRemainingQuantity
      );
    }
  }

  // Keep backward-compatible entity in sync.
  let revealDrawSentID = getRevealRequestEntityId(event.params.requestId);
  let revealDrawSent = RevealDrawSent.load(revealDrawSentID);
  if (revealDrawSent) {
    revealDrawSent.seriesID = event.params.seriesID;
    revealDrawSent.randomWords = event.params.randomWords;
    revealDrawSent.subPrizesRemainingQuantities = subPrizesRemainingQuantitiesAfter;
    revealDrawSent.save();
  }

  // New transparent request-level entity for frontend trust display.
  let revealRequestId = getRevealRequestEntityId(event.params.requestId);
  let revealRequest = RevealVRFRequest.load(revealRequestId);
  if (!revealRequest) {
    revealRequest = new RevealVRFRequest(revealRequestId);
    revealRequest.requestId = event.params.requestId;
    revealRequest.tokenIDs = revealDrawSent
      ? revealDrawSent.tokenIDs
      : new Array<BigInt>();
    revealRequest.randomWords = new Array<BigInt>();
    revealRequest.subPrizeIDs = new Array<BigInt>();
    revealRequest.subPrizeRemainingQuantitiesBefore = new Array<BigInt>();
    revealRequest.subPrizeRemainingQuantitiesAfter = new Array<BigInt>();
    revealRequest.isFulfilled = false;
    revealRequest.sentBlockNumber = event.block.number;
    revealRequest.sentBlockTimestamp = event.block.timestamp;
    revealRequest.sentTransactionHash = event.transaction.hash;
  }

  let tokenIDs = revealRequest.tokenIDs;
  if (tokenIDs.length == 0 && revealDrawSent) {
    tokenIDs = revealDrawSent.tokenIDs;
    revealRequest.tokenIDs = tokenIDs;
  }

  revealRequest.seriesID = event.params.seriesID;
  revealRequest.randomWords = event.params.randomWords;
  if (revealRequest.subPrizeIDs.length == 0 && subPrizeIDsAfter.length > 0) {
    revealRequest.subPrizeIDs = subPrizeIDsAfter;
  }
  if (
    revealRequest.subPrizeRemainingQuantitiesBefore.length == 0 &&
    subPrizesRemainingQuantitiesAfter.length > 0
  ) {
    // Fallback when sent event was not indexed; prevents negative deltas.
    revealRequest.subPrizeRemainingQuantitiesBefore =
      subPrizesRemainingQuantitiesAfter;
  }
  revealRequest.subPrizeRemainingQuantitiesAfter = subPrizesRemainingQuantitiesAfter;
  revealRequest.isFulfilled = true;
  revealRequest.fulfilledBlockNumber = event.block.number;
  revealRequest.fulfilledBlockTimestamp = event.block.timestamp;
  revealRequest.fulfilledTransactionHash = event.transaction.hash;
  revealRequest.save();

  let revealedPrizeIDs = new Array<BigInt>();
  for (let i = 0; i < tokenIDs.length; i++) {
    let tokenID = tokenIDs[i];
    let tokenResultId = getTokenResultEntityId(event.params.requestId, tokenID);
    let tokenResult = RevealVRFTokenResult.load(tokenResultId);
    if (!tokenResult) {
      tokenResult = new RevealVRFTokenResult(tokenResultId);
      tokenResult.requestId = event.params.requestId;
      tokenResult.tokenID = tokenID;
      tokenResult.revealIndex = BigInt.fromI32(i);
    }

    tokenResult.revealRequest = revealRequestId;
    tokenResult.requestId = event.params.requestId;
    tokenResult.seriesID = event.params.seriesID;
    tokenResult.tokenID = tokenID;
    tokenResult.revealIndex = BigInt.fromI32(i);
    if (i < event.params.randomWords.length) {
      tokenResult.vrfRandomWord = event.params.randomWords[i];
    }

    let ticketStatusResult = contract.try_ticketStatusDetail(tokenID);
    if (!ticketStatusResult.reverted) {
      let revealedPrizeID = ticketStatusResult.value.getTokenRevealedPrize();
      tokenResult.revealedPrizeID = revealedPrizeID;
      revealedPrizeIDs.push(revealedPrizeID);
    }

    tokenResult.blockNumber = event.block.number;
    tokenResult.blockTimestamp = event.block.timestamp;
    tokenResult.transactionHash = event.transaction.hash;
    tokenResult.save();
  }

  let subPrizeIDsBefore = revealRequest.subPrizeIDs;
  let quantitiesBefore = revealRequest.subPrizeRemainingQuantitiesBefore;
  for (let i = 0; i < subPrizesDetail.length; i++) {
    let subPrize = subPrizesDetail[i];
    let quantityAfter = subPrize.subPrizeRemainingQuantity;
    let quantityBefore = findBeforeQuantity(
      subPrizeIDsBefore,
      quantitiesBefore,
      subPrize.subPrizeID,
      quantityAfter
    );
    let distributedByQuantityDelta = ZERO_BI;
    if (quantityBefore.ge(quantityAfter)) {
      distributedByQuantityDelta = quantityBefore.minus(quantityAfter);
    }

    let distribution = new RevealVRFPrizeDistribution(
      getPrizeDistributionEntityId(event.params.requestId, subPrize.subPrizeID)
    );
    distribution.revealRequest = revealRequestId;
    distribution.requestId = event.params.requestId;
    distribution.seriesID = event.params.seriesID;
    distribution.subPrizeID = subPrize.subPrizeID;
    distribution.prizeGroup = subPrize.prizeGroup;
    distribution.subPrizeName = subPrize.subPrizeName;
    distribution.quantityBefore = quantityBefore;
    distribution.quantityAfter = quantityAfter;
    distribution.distributedByQuantityDelta = distributedByQuantityDelta;
    distribution.distributedByTokenResults = countTokenResultsForPrize(
      revealedPrizeIDs,
      subPrize.subPrizeID
    );
    distribution.blockNumber = event.block.number;
    distribution.blockTimestamp = event.block.timestamp;
    distribution.transactionHash = event.transaction.hash;
    distribution.save();
  }
}

export function handleRevealDrawSent(event: RevealDrawSentEvent): void {
  let requestEntityId = getRevealRequestEntityId(event.params.requestId);
  let entity = new RevealDrawSent(requestEntityId);
  entity.requestId = event.params.requestId;
  entity.tokenIDs = event.params.tokenIDs;
  entity.randomWords = new Array<BigInt>();
  entity.subPrizesRemainingQuantities = new Array<BigInt>();

  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;

  entity.save();

  let contract = ICHICHAIN.bind(event.address);
  let hasSeriesID = false;
  let seriesID = ZERO_BI;
  if (event.params.tokenIDs.length > 0) {
    let ticketStatusResult = contract.try_ticketStatusDetail(
      event.params.tokenIDs[0]
    );
    if (!ticketStatusResult.reverted) {
      hasSeriesID = true;
      seriesID = ticketStatusResult.value.getSeriesID();
    }
  }

  let subPrizeIDs = new Array<BigInt>();
  let subPrizeRemainingQuantitiesBefore = new Array<BigInt>();
  if (hasSeriesID) {
    let subPrizesDetailResult = contract.try_getSubPrizesDetail(seriesID);
    if (!subPrizesDetailResult.reverted) {
      let subPrizesDetail = subPrizesDetailResult.value;
      for (let i = 0; i < subPrizesDetail.length; i++) {
        subPrizeIDs.push(subPrizesDetail[i].subPrizeID);
        subPrizeRemainingQuantitiesBefore.push(
          subPrizesDetail[i].subPrizeRemainingQuantity
        );
      }
    }
  }

  let revealRequest = new RevealVRFRequest(requestEntityId);
  revealRequest.requestId = event.params.requestId;
  if (hasSeriesID) {
    revealRequest.seriesID = seriesID;
  }
  revealRequest.tokenIDs = event.params.tokenIDs;
  revealRequest.randomWords = new Array<BigInt>();
  revealRequest.subPrizeIDs = subPrizeIDs;
  revealRequest.subPrizeRemainingQuantitiesBefore =
    subPrizeRemainingQuantitiesBefore;
  revealRequest.subPrizeRemainingQuantitiesAfter = new Array<BigInt>();
  revealRequest.isFulfilled = false;
  revealRequest.sentBlockNumber = event.block.number;
  revealRequest.sentBlockTimestamp = event.block.timestamp;
  revealRequest.sentTransactionHash = event.transaction.hash;
  revealRequest.save();

  for (let i = 0; i < event.params.tokenIDs.length; i++) {
    let tokenID = event.params.tokenIDs[i];
    let tokenResult = new RevealVRFTokenResult(
      getTokenResultEntityId(event.params.requestId, tokenID)
    );
    tokenResult.revealRequest = requestEntityId;
    tokenResult.requestId = event.params.requestId;
    if (hasSeriesID) {
      tokenResult.seriesID = seriesID;
    }
    tokenResult.tokenID = tokenID;
    tokenResult.revealIndex = BigInt.fromI32(i);
    tokenResult.blockNumber = event.block.number;
    tokenResult.blockTimestamp = event.block.timestamp;
    tokenResult.transactionHash = event.transaction.hash;
    tokenResult.save();
  }
}
