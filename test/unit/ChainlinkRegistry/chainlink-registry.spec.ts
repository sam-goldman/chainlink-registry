import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { behaviours, constants } from '@test-utils';
import { contract, given, then, when } from '@test-utils/bdd';
import { snapshot } from '@test-utils/evm';
import { AggregatorV3Interface, ChainlinkRegistry, ChainlinkRegistry__factory, IAggregatorProxy, IERC20 } from '@typechained';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { FakeContract, smock } from '@defi-wonderland/smock';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import { BigNumber } from 'ethers';
import { readArgFromEventOrFail } from '@test-utils/event-utils';

chai.use(smock.matchers);

contract('ChainlinkRegistry', () => {
  const LINK = '0xa36085F69e2889c224210F603D836748e7dC0088';
  const USD = '0x0000000000000000000000000000000000000348';

  let governor: SignerWithAddress;
  let feed: FakeContract<IAggregatorProxy>;
  let registry: ChainlinkRegistry;
  let token: FakeContract<IERC20>;
  let snapshotId: string;

  before('Setup accounts and contracts', async () => {
    [, governor] = await ethers.getSigners();
    const factory: ChainlinkRegistry__factory = await ethers.getContractFactory(
      'contracts/ChainlinkRegistry/ChainlinkRegistry.sol:ChainlinkRegistry'
    );
    registry = await factory.deploy(governor.address);
    feed = await smock.fake('IAggregatorProxy');
    token = await smock.fake('IERC20');
    token.transfer.returns(true);
    snapshotId = await snapshot.take();
  });

  beforeEach('Deploy and configure', async () => {
    await snapshot.revert(snapshotId);
  });

  describe('assignFeeds', () => {
    when('setting a feed', () => {
      let tx: TransactionResponse;
      given(async () => {
        tx = await registry.connect(governor).assignFeeds([{ base: LINK, quote: USD, feed: feed.address }]);
      });
      then('it is set correctly', async () => {
        const assignedFeed = await registry.getAssignedFeed(LINK, USD);
        expect(assignedFeed.feed).to.equal(feed.address);
        expect(assignedFeed.isProxy).to.equal(true);
      });
      then('event is emitted', async () => {
        await expectEventToHaveBeenEmitted(tx, feed.address);
      });
    });
    when('setting a feed that is not a proxy', () => {
      let tx: TransactionResponse;
      given(async () => {
        tx = await registry.connect(governor).assignFeeds([{ base: LINK, quote: USD, feed: registry.address }]);
      });
      then('it is set correctly', async () => {
        const assignedFeed = await registry.getAssignedFeed(LINK, USD);
        expect(assignedFeed.feed).to.equal(registry.address);
        expect(assignedFeed.isProxy).to.equal(false);
      });
      then('event is emitted', async () => {
        await expectEventToHaveBeenEmitted(tx, registry.address);
      });
    });
    when('removing a feed', () => {
      let tx: TransactionResponse;
      given(async () => {
        await registry.connect(governor).assignFeeds([{ base: LINK, quote: USD, feed: feed.address }]);
        tx = await registry.connect(governor).assignFeeds([{ base: LINK, quote: USD, feed: constants.ZERO_ADDRESS }]);
      });
      then('feed is removed correctly', async () => {
        const assignedFeed = await registry.getAssignedFeed(LINK, USD);
        expect(assignedFeed.feed).to.equal(constants.ZERO_ADDRESS);
        expect(assignedFeed.isProxy).to.equal(false);
      });
      then('event is emitted', async () => {
        await expectEventToHaveBeenEmitted(tx, constants.ZERO_ADDRESS);
      });
    });
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => registry,
      funcAndSignature: 'assignFeeds',
      params: () => [[{ base: constants.NOT_ZERO_ADDRESS, quote: constants.NOT_ZERO_ADDRESS, feed: constants.NOT_ZERO_ADDRESS }]],
      governor: () => governor,
    });
    async function expectEventToHaveBeenEmitted(tx: TransactionResponse, feed: string) {
      const feeds: { base: string; quote: string; feed: string }[] = await readArgFromEventOrFail(tx, 'FeedsModified', 'feeds');
      expect(feeds.length).to.equal(1);
      expect(feeds[0].base).to.equal(LINK);
      expect(feeds[0].quote).to.equal(USD);
      expect(feeds[0].feed).to.equal(feed);
    }
  });

  describe('sendDust', () => {
    behaviours.shouldBeExecutableOnlyByGovernor({
      contract: () => registry,
      funcAndSignature: 'sendDust',
      params: () => [constants.NOT_ZERO_ADDRESS, token.address, 2000],
      governor: () => governor,
    });
  });

  redirectTest({
    method: 'decimals',
    returnsWhenMocked: 18,
  });

  redirectTest({
    method: 'description',
    returnsWhenMocked: 'some random description',
  });

  redirectTest({
    method: 'version',
    returnsWhenMocked: BigNumber.from(2),
  });

  redirectTest({
    method: 'latestRoundData',
    returnsWhenMocked: [BigNumber.from(1), BigNumber.from(2), BigNumber.from(3), BigNumber.from(4), BigNumber.from(5)],
  });

  /**
   * This test makes sure that when a method is called and the feed is not set, then the call reverts.
   * However, when the method is called and there is a feed set, then the return value is just redirected
   * from the feed, to the registry's caller
   */
  function redirectTest<Key extends keyof Functions, ReturnValue extends Awaited<ReturnType<Functions[Key]>>>({
    method,
    returnsWhenMocked: returnValue,
  }: {
    method: Key;
    returnsWhenMocked: Arrayed<ReturnValue> | ReturnValue;
  }) {
    describe(method, () => {
      when('feed is not set', () => {
        then(`calling ${method} will revert with message`, async () => {
          await behaviours.txShouldRevertWithMessage({
            contract: registry,
            func: method,
            args: [constants.NOT_ZERO_ADDRESS, USD],
            message: 'FeedNotFound',
          });
        });
      });
      when('feed is set', () => {
        given(async () => {
          await registry.connect(governor).assignFeeds([{ base: LINK, quote: USD, feed: feed.address }]);
          feed[method].returns(returnValue);
        });
        then('return value from feed is returned through registry', async () => {
          const result = await registry[method](LINK, USD);
          expect(result).to.eql(returnValue);
        });
      });
    });
  }
  type Keys = keyof AggregatorV3Interface['functions'] & keyof ChainlinkRegistry['functions'];
  type Functions = Pick<AggregatorV3Interface['functions'] & ChainlinkRegistry['functions'], Keys>;
  type Awaited<T> = T extends PromiseLike<infer U> ? U : T;
  type Arrayed<T> = T extends Array<infer U> ? U : T;
});
